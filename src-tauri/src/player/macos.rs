//! macOS video surface for the built-in player.
//!
//! A layer-hosting `NSView` is inserted *below* the WKWebView inside the window's content view.
//! Its layer is a `CAOpenGLLayer` subclass that libmpv renders into via the render API, and the
//! (transparent) webview above it draws the player controls — so HTML is composited over video.

use super::mpv::{self, OpenGlFbo, OpenGlInitParams, RenderParam};
use libloading::Library;
use objc2::ffi;
use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{class, msg_send, sel};
use objc2_foundation::{NSNumber, NSRect, NSString};
use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};

#[link(name = "QuartzCore", kind = "framework")]
extern "C" {}

// --- OpenGL / CGL (OpenGL.framework) -----------------------------------------------------------

const GL_VIEWPORT: u32 = 0x0BA2;
const GL_FRAMEBUFFER_BINDING: u32 = 0x8CA6;
const GL_COLOR_BUFFER_BIT: u32 = 0x4000;

struct Gl {
    lib: Library,
    get_integerv: unsafe extern "C" fn(u32, *mut c_int),
    clear_color: unsafe extern "C" fn(f32, f32, f32, f32),
    clear: unsafe extern "C" fn(u32),
    flush: unsafe extern "C" fn(),
    cgl_set_current_context: unsafe extern "C" fn(*mut c_void) -> c_int,
    cgl_choose_pixel_format: unsafe extern "C" fn(*const c_int, *mut *mut c_void, *mut c_int) -> c_int,
    cgl_create_context: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut *mut c_void) -> c_int,
    cgl_retain_context: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    cgl_release_context: unsafe extern "C" fn(*mut c_void),
    cgl_retain_pixel_format: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    cgl_release_pixel_format: unsafe extern "C" fn(*mut c_void),
}

unsafe impl Send for Gl {}
unsafe impl Sync for Gl {}

fn gl() -> Result<&'static Gl, String> {
    static GL: OnceLock<Result<Gl, String>> = OnceLock::new();
    GL.get_or_init(|| unsafe {
        let lib = Library::new("/System/Library/Frameworks/OpenGL.framework/OpenGL").map_err(|e| e.to_string())?;
        macro_rules! f {
            ($n:literal) => {
                *lib.get(concat!($n, "\0").as_bytes()).map_err(|e| e.to_string())?
            };
        }
        Ok(Gl {
            get_integerv: f!("glGetIntegerv"),
            clear_color: f!("glClearColor"),
            clear: f!("glClear"),
            flush: f!("glFlush"),
            cgl_set_current_context: f!("CGLSetCurrentContext"),
            cgl_choose_pixel_format: f!("CGLChoosePixelFormat"),
            cgl_create_context: f!("CGLCreateContext"),
            cgl_retain_context: f!("CGLRetainContext"),
            cgl_release_context: f!("CGLReleaseContext"),
            cgl_retain_pixel_format: f!("CGLRetainPixelFormat"),
            cgl_release_pixel_format: f!("CGLReleasePixelFormat"),
            lib,
        })
    })
    .as_ref()
    .map_err(Clone::clone)
}

unsafe extern "C" fn get_proc_address(_ctx: *mut c_void, name: *const c_char) -> *mut c_void {
    let Ok(gl) = gl() else { return std::ptr::null_mut() };
    let name = CStr::from_ptr(name).to_bytes_with_nul();
    gl.lib.get::<*mut c_void>(name).map(|s| *s).unwrap_or(std::ptr::null_mut())
}

// --- Render state ------------------------------------------------------------------------------

#[derive(Default)]
struct RenderState {
    mpv: usize, // *mut mpv::Handle
    ctx: usize, // *mut mpv::RenderContext
    cgl: usize, // our CGLContextObj, shared with the layer
    pf: usize,  // its CGLPixelFormatObj
}

static RENDER: Mutex<RenderState> = Mutex::new(RenderState { mpv: 0, ctx: 0, cgl: 0, pf: 0 });
/// The live layer (retained). The render thread holds this lock while drawing, so detach can't
/// free the layer mid-frame.
static LAYER: Mutex<usize> = Mutex::new(0);
/// The hosting NSView (retained), touched on the main thread only.
static VIEW: AtomicUsize = AtomicUsize::new(0);
/// Set by mpv's update callback; the render thread waits on it.
static REDRAW: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

unsafe extern "C" fn on_mpv_update(_ctx: *mut c_void) {
    probe::UPDATES.fetch_add(1, Ordering::Relaxed);
    request_redraw();
}

fn request_redraw() {
    let (flag, cv) = &REDRAW;
    *flag.lock().unwrap() = true;
    cv.notify_one();
}

/// Dedicated render thread (like IINA's): draws the layer whenever mpv has a new frame and
/// flushes the Core Animation transaction so it reaches the screen immediately.
fn ensure_render_thread() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::Builder::new()
        .name("mpv-render".into())
        .spawn(|| loop {
            {
                let (flag, cv) = &REDRAW;
                let mut pending = flag.lock().unwrap();
                while !*pending {
                    pending = cv.wait(pending).unwrap();
                }
                *pending = false;
            }
            objc2::rc::autoreleasepool(|_| {
                let layer = LAYER.lock().unwrap();
                if *layer != 0 {
                    unsafe {
                        let _: () = msg_send![*layer as *mut AnyObject, display];
                        let _: () = msg_send![class!(CATransaction), flush];
                    }
                }
            });
        })
        .expect("spawn render thread");
}

/// Debug aid (`TRUONGFLIX_PLAYER_PROBE=1`): reads back the centre pixel of each rendered frame so
/// tests can prove real video frames reach the surface without screen-recording permission.
pub mod probe {
    use super::Gl;
    use std::collections::HashSet;
    use std::ffi::{c_int, c_void};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, OnceLock};

    pub static FRAMES: AtomicU64 = AtomicU64::new(0);
    pub static UPDATES: AtomicU64 = AtomicU64::new(0);
    pub static DRAWS: AtomicU64 = AtomicU64::new(0);
    pub static COLORS: Mutex<Option<HashSet<u32>>> = Mutex::new(None);

    pub fn summary() -> String {
        let window = super::VIEW.load(Ordering::Acquire) as *mut objc2::runtime::AnyObject;
        let occlusion: usize = if window.is_null() {
            0
        } else {
            unsafe {
                let w: *mut objc2::runtime::AnyObject = objc2::msg_send![window, window];
                if w.is_null() { 0 } else { objc2::msg_send![w, occlusionState] }
            }
        };
        format!(
            "updates={} draws={} probed={} window_visible={}",
            UPDATES.load(Ordering::Relaxed),
            DRAWS.load(Ordering::Relaxed),
            FRAMES.load(Ordering::Relaxed),
            occlusion & 2 != 0
        )
    }

    fn enabled() -> bool {
        static ON: OnceLock<bool> = OnceLock::new();
        *ON.get_or_init(|| std::env::var_os("TRUONGFLIX_PLAYER_PROBE").is_some())
    }

    pub(super) unsafe fn sample(gl: &Gl, viewport: [c_int; 4], fbo: c_int, rc: c_int) {
        if !enabled() {
            return;
        }
        type ReadPixels = unsafe extern "C" fn(c_int, c_int, c_int, c_int, u32, u32, *mut c_void);
        type BindFramebuffer = unsafe extern "C" fn(u32, u32);
        let Ok(read) = gl.lib.get::<ReadPixels>(b"glReadPixels\0") else { return };
        let Ok(bind) = gl.lib.get::<BindFramebuffer>(b"glBindFramebuffer\0") else { return };
        // GL_READ_FRAMEBUFFER: read back exactly what mpv drew into.
        (bind)(0x8CA8, fbo as u32);
        // One readback of the whole frame, then hash an 8x8 grid: identical hashes = identical images.
        let (w, h) = (viewport[2].max(1) as usize, viewport[3].max(1) as usize);
        let mut buf = vec![0u8; w * h * 4];
        (read)(0, 0, w as c_int, h as c_int, 0x1908, 0x1401, buf.as_mut_ptr().cast());
        let mut hash: u32 = 2166136261;
        for gy in 1..=8 {
            for gx in 1..=8 {
                let i = ((h * gy / 9) * w + (w * gx / 9)) * 4;
                for b in &buf[i..i + 4] {
                    hash = (hash ^ *b as u32).wrapping_mul(16777619);
                }
            }
        }
        let n = FRAMES.fetch_add(1, Ordering::Relaxed);
        if n % 20 == 0 {
            let c = ((h / 2) * w + w / 2) * 4;
            eprintln!("[probe] frame {n} fbo={fbo} render_rc={rc} viewport={w}x{h} centre rgba={:?}", &buf[c..c + 4]);
        }
        COLORS.lock().unwrap().get_or_insert_with(HashSet::new).insert(hash);
    }
}

// --- CAOpenGLLayer subclass --------------------------------------------------------------------

unsafe extern "C-unwind" fn can_draw(_this: *mut AnyObject, _sel: Sel, _ctx: *mut c_void, _pf: *mut c_void, _t: f64, _ts: *const c_void) -> Bool {
    Bool::YES
}

/// OpenGL 3.2 core, accelerated, double-buffered (what mpv's renderer and VideoToolbox interop want).
unsafe fn choose_pixel_format(gl: &Gl) -> *mut c_void {
    let attrs: [c_int; 12] = [99, 0x3200, 73, 5, 8, 24, 11, 8, 96, 101, 0, 0];
    let mut pf = std::ptr::null_mut();
    let mut n = 0;
    (gl.cgl_choose_pixel_format)(attrs.as_ptr(), &mut pf, &mut n);
    if pf.is_null() {
        let fallback: [c_int; 4] = [73, 5, 0, 0];
        (gl.cgl_choose_pixel_format)(fallback.as_ptr(), &mut pf, &mut n);
    }
    pf
}

// The layer renders with *our* context, so the mpv render context can be created up front.
unsafe extern "C-unwind" fn copy_pixel_format(_this: *mut AnyObject, _sel: Sel, _mask: u32) -> *mut c_void {
    let Ok(gl) = gl() else { return std::ptr::null_mut() };
    let pf = RENDER.lock().unwrap().pf as *mut c_void;
    if pf.is_null() { choose_pixel_format(gl) } else { (gl.cgl_retain_pixel_format)(pf) }
}

unsafe extern "C-unwind" fn copy_context(_this: *mut AnyObject, _sel: Sel, _pf: *mut c_void) -> *mut c_void {
    let Ok(gl) = gl() else { return std::ptr::null_mut() };
    let cgl = RENDER.lock().unwrap().cgl as *mut c_void;
    if cgl.is_null() { std::ptr::null_mut() } else { (gl.cgl_retain_context)(cgl) }
}

unsafe extern "C-unwind" fn draw(_this: *mut AnyObject, _sel: Sel, _cgl: *mut c_void, _pf: *mut c_void, _t: f64, _ts: *const c_void) {
    probe::DRAWS.fetch_add(1, Ordering::Relaxed);
    let (Ok(gl), Ok(api)) = (gl(), mpv::api()) else { return };
    let st = RENDER.lock().unwrap();

    let mut viewport = [0 as c_int; 4];
    (gl.get_integerv)(GL_VIEWPORT, viewport.as_mut_ptr());
    if st.ctx != 0 {
        let ctx = st.ctx as *mut mpv::RenderContext;
        (api.render_context_update)(ctx);
        let mut fbo_id: c_int = 0;
        (gl.get_integerv)(GL_FRAMEBUFFER_BINDING, &mut fbo_id);
        let mut fbo = OpenGlFbo { fbo: fbo_id, w: viewport[2], h: viewport[3], internal_format: 0 };
        let mut flip: c_int = 1;
        let mut params = [
            RenderParam { kind: mpv::RENDER_PARAM_OPENGL_FBO, data: (&mut fbo as *mut OpenGlFbo).cast() },
            RenderParam { kind: mpv::RENDER_PARAM_FLIP_Y, data: (&mut flip as *mut c_int).cast() },
            RenderParam { kind: mpv::RENDER_PARAM_INVALID, data: std::ptr::null_mut() },
        ];
        let rc = (api.render_context_render)(ctx, params.as_mut_ptr());
        probe::sample(gl, viewport, fbo_id, rc);
    } else {
        (gl.clear_color)(0.0, 0.0, 0.0, 1.0);
        (gl.clear)(GL_COLOR_BUFFER_BIT);
    }
    (gl.flush)();
}

fn layer_class() -> Result<&'static AnyClass, String> {
    static CLASS: OnceLock<usize> = OnceLock::new();
    let ptr = *CLASS.get_or_init(|| unsafe {
        let Some(superclass) = AnyClass::get(c"CAOpenGLLayer") else { return 0 };
        let cls = ffi::objc_allocateClassPair(superclass, c"TruongFlixVideoLayer".as_ptr(), 0);
        if cls.is_null() {
            return AnyClass::get(c"TruongFlixVideoLayer").map(|c| c as *const AnyClass as usize).unwrap_or(0);
        }
        // Registered through the raw runtime so CGL/CVTimeStamp pointer types need no Encode impls.
        let add = |name: Sel, imp: Imp, types: &CStr| {
            ffi::class_addMethod(cls, name, imp, types.as_ptr());
        };
        type DrawFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut c_void, *mut c_void, f64, *const c_void);
        type CanDrawFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut c_void, *mut c_void, f64, *const c_void) -> Bool;
        type PixelFormatFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, u32) -> *mut c_void;
        add(
            sel!(canDrawInCGLContext:pixelFormat:forLayerTime:displayTime:),
            std::mem::transmute::<CanDrawFn, Imp>(can_draw),
            c"B@:^v^vd^v",
        );
        add(
            sel!(drawInCGLContext:pixelFormat:forLayerTime:displayTime:),
            std::mem::transmute::<DrawFn, Imp>(draw),
            c"v@:^v^vd^v",
        );
        add(
            sel!(copyCGLPixelFormatForDisplayMask:),
            std::mem::transmute::<PixelFormatFn, Imp>(copy_pixel_format),
            c"^v@:I",
        );
        type ContextFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut c_void) -> *mut c_void;
        add(
            sel!(copyCGLContextForPixelFormat:),
            std::mem::transmute::<ContextFn, Imp>(copy_context),
            c"^v@:^v",
        );

        ffi::objc_registerClassPair(cls);
        cls as usize
    });
    if ptr == 0 {
        return Err("CAOpenGLLayer is unavailable".into());
    }
    Ok(unsafe { &*(ptr as *const AnyClass) })
}

// --- Attach / detach (main thread only) --------------------------------------------------------

fn find_webview(content: *mut AnyObject) -> *mut AnyObject {
    unsafe {
        let subviews: *mut AnyObject = msg_send![content, subviews];
        let count: usize = msg_send![subviews, count];
        for i in 0..count {
            let v: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
            if (*v).class().name().to_string_lossy().contains("WebView") {
                return v;
            }
        }
        std::ptr::null_mut()
    }
}

/// Inserts the video view below the webview and points it at `handle`. Must run on the main thread.
/// Draws once synchronously so the render context exists before any file is loaded (otherwise
/// mpv's video init would fail).
pub fn attach(ns_window: *mut c_void, handle: *mut mpv::Handle) -> Result<(), String> {
    detach();
    let cls = layer_class()?;
    let (gl, api) = (gl()?, mpv::api()?);

    // Our own GL context + the mpv render context, created before the layer ever draws.
    unsafe {
        let pf = choose_pixel_format(gl);
        if pf.is_null() {
            return Err("No suitable OpenGL pixel format".into());
        }
        let mut cgl = std::ptr::null_mut();
        if (gl.cgl_create_context)(pf, std::ptr::null_mut(), &mut cgl) != 0 || cgl.is_null() {
            (gl.cgl_release_pixel_format)(pf);
            return Err("Couldn’t create an OpenGL context".into());
        }
        (gl.cgl_set_current_context)(cgl);
        let mut init = OpenGlInitParams { get_proc_address, get_proc_address_ctx: std::ptr::null_mut() };
        let mut params = [
            RenderParam { kind: mpv::RENDER_PARAM_API_TYPE, data: c"opengl".as_ptr() as *mut c_void },
            RenderParam { kind: mpv::RENDER_PARAM_OPENGL_INIT_PARAMS, data: (&mut init as *mut OpenGlInitParams).cast() },
            RenderParam { kind: mpv::RENDER_PARAM_INVALID, data: std::ptr::null_mut() },
        ];
        let mut ctx = std::ptr::null_mut();
        let rc = (api.render_context_create)(&mut ctx, handle, params.as_mut_ptr());
        (gl.cgl_set_current_context)(std::ptr::null_mut());
        if rc < 0 || ctx.is_null() {
            (gl.cgl_release_context)(cgl);
            (gl.cgl_release_pixel_format)(pf);
            return Err(format!("Couldn’t create the video renderer: {}", api.err(rc)));
        }
        *RENDER.lock().unwrap() = RenderState { mpv: handle as usize, ctx: ctx as usize, cgl: cgl as usize, pf: pf as usize };
    }

    unsafe {
        let window = ns_window as *mut AnyObject;
        let content: *mut AnyObject = msg_send![window, contentView];
        if content.is_null() {
            return Err("Window has no content view".into());
        }
        let bounds: NSRect = msg_send![content, bounds];
        let scale: f64 = msg_send![window, backingScaleFactor];

        let layer: Retained<AnyObject> = msg_send![cls, new];
        let _: () = msg_send![&*layer, setAsynchronous: false];
        let _: () = msg_send![&*layer, setNeedsDisplayOnBoundsChange: true];
        let _: () = msg_send![&*layer, setContentsScale: scale];

        let view: Allocated<AnyObject> = msg_send![class!(NSView), alloc];
        let view: Retained<AnyObject> = msg_send![view, initWithFrame: bounds];
        let _: () = msg_send![&*view, setLayer: &*layer];
        let _: () = msg_send![&*view, setWantsLayer: true];
        // NSViewWidthSizable | NSViewHeightSizable
        let _: () = msg_send![&*view, setAutoresizingMask: 18usize];

        let webview = find_webview(content);
        if !webview.is_null() {
            // Make sure the webview never paints an opaque background over the video.
            let no = NSNumber::numberWithBool(false);
            let key = NSString::from_str("drawsBackground");
            let _: () = msg_send![webview, setValue: &*no, forKey: &*key];
            let sel = sel!(setUnderPageBackgroundColor:);
            let responds: bool = msg_send![webview, respondsToSelector: sel];
            if responds {
                let clear: *mut AnyObject = msg_send![class!(NSColor), clearColor];
                let _: () = msg_send![webview, setUnderPageBackgroundColor: clear];
            }
        }
        // NSWindowBelow = -1
        let _: () = msg_send![content, addSubview: &*view, positioned: -1isize, relativeTo: webview];
        if std::env::var_os("TRUONGFLIX_PLAYER_DEBUG").is_some() || std::env::var_os("TRUONGFLIX_PLAYER_PROBE").is_some() {
            let content_cls = (*content).class().name().to_string_lossy().into_owned();
            eprintln!(
                "[player] attached under webview={} in {content_cls} ({}x{} @{scale}x)",
                !webview.is_null(),
                bounds.size.width,
                bounds.size.height
            );
        }

        let _: () = msg_send![&*layer, setNeedsDisplay];
        // Keep our own references; released in detach() after the render context is gone.
        *LAYER.lock().unwrap() = Retained::into_raw(layer) as usize;
        VIEW.store(Retained::into_raw(view) as usize, Ordering::Release);
        ensure_render_thread();
        let ctx = RENDER.lock().unwrap().ctx as *mut mpv::RenderContext;
        (api.render_context_set_update_callback)(ctx, Some(on_mpv_update), std::ptr::null_mut());
    }
    Ok(())
}

/// Test helper: a plain window to render into (used by the smoke-test example).
#[doc(hidden)]
pub fn test_window() -> *mut c_void {
    use objc2_foundation::{NSPoint, NSSize};
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: bool = msg_send![app, setActivationPolicy: 0isize];
        let rect = NSRect::new(NSPoint::new(60.0, 60.0), NSSize::new(480.0, 270.0));
        let w: Allocated<AnyObject> = msg_send![class!(NSWindow), alloc];
        let w: Retained<AnyObject> = msg_send![w, initWithContentRect: rect, styleMask: 3usize, backing: 2usize, defer: false];
        let _: () = msg_send![app, finishLaunching];
        let _: () = msg_send![&*w, makeKeyAndOrderFront: std::ptr::null_mut::<AnyObject>()];
        let _: () = msg_send![app, activateIgnoringOtherApps: true];
        let ptr = Retained::into_raw(w);
        TEST_WINDOW.store(ptr as usize, Ordering::Release);
        ptr.cast()
    }
}

static TEST_WINDOW: AtomicUsize = AtomicUsize::new(0);

/// Test helper: runs a real AppKit event loop for `seconds` and returns the window's occlusion state.
#[doc(hidden)]
pub fn pump(seconds: f64) -> String {
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let mode = NSString::from_str("kCFRunLoopDefaultMode");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs_f64(seconds);
        while std::time::Instant::now() < deadline {
            objc2::rc::autoreleasepool(|_| {
                let until: *mut AnyObject = msg_send![class!(NSDate), dateWithTimeIntervalSinceNow: 0.01f64];
                let ev: *mut AnyObject = msg_send![app, nextEventMatchingMask: u64::MAX, untilDate: until, inMode: &*mode, dequeue: true];
                if !ev.is_null() {
                    let _: () = msg_send![app, sendEvent: ev];
                }
                let _: () = msg_send![app, updateWindows];
            });
        }
        let w = TEST_WINDOW.load(Ordering::Acquire) as *mut AnyObject;
        let occlusion: usize = if w.is_null() { 0 } else { msg_send![w, occlusionState] };
        format!("window visible={}", occlusion & 2 != 0)
    }
}

/// Detaches only if the surface still belongs to `handle` (a newer session may have replaced it).
pub fn detach_for(handle: usize) {
    if RENDER.lock().unwrap().mpv == handle {
        detach();
    }
}

/// Frees the render context (with its GL context current) and removes the view. Main thread only.
/// Must happen before the mpv core is destroyed.
fn detach() {
    let Ok(api) = mpv::api() else { return };
    // Taking the lock waits for any in-flight frame on the render thread to finish.
    let layer = std::mem::take(&mut *LAYER.lock().unwrap()) as *mut AnyObject;
    {
        let mut st = RENDER.lock().unwrap();
        if let Ok(gl) = gl() {
            unsafe {
                if st.ctx != 0 {
                    (gl.cgl_set_current_context)(st.cgl as *mut c_void);
                    (api.render_context_free)(st.ctx as *mut mpv::RenderContext);
                    (gl.cgl_set_current_context)(std::ptr::null_mut());
                }
                if st.cgl != 0 {
                    (gl.cgl_release_context)(st.cgl as *mut c_void);
                }
                if st.pf != 0 {
                    (gl.cgl_release_pixel_format)(st.pf as *mut c_void);
                }
            }
        }
        *st = RenderState::default();
    }
    let view = VIEW.swap(0, Ordering::AcqRel) as *mut AnyObject;
    unsafe {
        if !view.is_null() {
            let _: () = msg_send![view, removeFromSuperview];
            drop(Retained::from_raw(view));
        }
        if !layer.is_null() {
            drop(Retained::from_raw(layer));
        }
    }
}
