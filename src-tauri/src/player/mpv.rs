//! Minimal runtime-loaded bindings for libmpv's client + render API (mpv/client.h, render.h, render_gl.h).

use libloading::Library;
use std::ffi::{c_char, c_double, c_int, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::OnceLock;

pub type Handle = c_void;
pub type RenderContext = c_void;

// mpv_format
pub const FORMAT_STRING: c_int = 1;
pub const FORMAT_FLAG: c_int = 3;
pub const FORMAT_DOUBLE: c_int = 5;

// mpv_event_id
pub const EVENT_SHUTDOWN: c_int = 1;
pub const EVENT_END_FILE: c_int = 7;
pub const EVENT_FILE_LOADED: c_int = 8;
pub const EVENT_PROPERTY_CHANGE: c_int = 22;

// mpv_end_file_reason
pub const END_FILE_REASON_ERROR: c_int = 4;

// mpv_render_param_type
pub const RENDER_PARAM_INVALID: c_int = 0;
pub const RENDER_PARAM_API_TYPE: c_int = 1;
pub const RENDER_PARAM_OPENGL_INIT_PARAMS: c_int = 2;
pub const RENDER_PARAM_OPENGL_FBO: c_int = 3;
pub const RENDER_PARAM_FLIP_Y: c_int = 4;

#[repr(C)]
pub struct Event {
    pub event_id: c_int,
    pub error: c_int,
    pub reply_userdata: u64,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct EventProperty {
    pub name: *const c_char,
    pub format: c_int,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct EventEndFile {
    pub reason: c_int,
    pub error: c_int,
    pub playlist_entry_id: i64,
}

#[repr(C)]
pub struct RenderParam {
    pub kind: c_int,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct OpenGlInitParams {
    pub get_proc_address: unsafe extern "C" fn(ctx: *mut c_void, name: *const c_char) -> *mut c_void,
    pub get_proc_address_ctx: *mut c_void,
}

#[repr(C)]
pub struct OpenGlFbo {
    pub fbo: c_int,
    pub w: c_int,
    pub h: c_int,
    pub internal_format: c_int,
}

pub type UpdateFn = unsafe extern "C" fn(ctx: *mut c_void);

/// Function table resolved from libmpv.
pub struct Api {
    _lib: Library,
    pub path: PathBuf,
    pub error_string: unsafe extern "C" fn(c_int) -> *const c_char,
    pub free: unsafe extern "C" fn(*mut c_void),
    pub create: unsafe extern "C" fn() -> *mut Handle,
    pub initialize: unsafe extern "C" fn(*mut Handle) -> c_int,
    pub terminate_destroy: unsafe extern "C" fn(*mut Handle),
    pub set_option_string: unsafe extern "C" fn(*mut Handle, *const c_char, *const c_char) -> c_int,
    pub command: unsafe extern "C" fn(*mut Handle, *mut *const c_char) -> c_int,
    pub set_property_string: unsafe extern "C" fn(*mut Handle, *const c_char, *const c_char) -> c_int,
    pub get_property_string: unsafe extern "C" fn(*mut Handle, *const c_char) -> *mut c_char,
    pub observe_property: unsafe extern "C" fn(*mut Handle, u64, *const c_char, c_int) -> c_int,
    pub wait_event: unsafe extern "C" fn(*mut Handle, c_double) -> *mut Event,
    pub render_context_create: unsafe extern "C" fn(*mut *mut RenderContext, *mut Handle, *mut RenderParam) -> c_int,
    pub render_context_set_update_callback: unsafe extern "C" fn(*mut RenderContext, Option<UpdateFn>, *mut c_void),
    pub render_context_update: unsafe extern "C" fn(*mut RenderContext) -> u64,
    pub render_context_render: unsafe extern "C" fn(*mut RenderContext, *mut RenderParam) -> c_int,
    pub render_context_free: unsafe extern "C" fn(*mut RenderContext),
}

unsafe impl Send for Api {}
unsafe impl Sync for Api {}

fn candidate_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(p) = std::env::var_os("TRUONGFLIX_LIBMPV") {
        paths.push(PathBuf::from(p));
    }
    // Bundled copy inside the app (Contents/Frameworks on macOS, next to the exe on Windows).
    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        #[cfg(target_os = "macos")]
        paths.push(exe_dir.join("../Frameworks/libmpv.2.dylib"));
        #[cfg(target_os = "windows")]
        paths.push(exe_dir.join("libmpv-2.dll"));
        #[cfg(target_os = "linux")]
        paths.push(exe_dir.join("libmpv.so.2"));
    }
    #[cfg(target_os = "macos")]
    for p in ["/opt/homebrew/lib/libmpv.2.dylib", "/usr/local/lib/libmpv.2.dylib", "/opt/homebrew/lib/libmpv.dylib", "/usr/local/lib/libmpv.dylib"] {
        paths.push(PathBuf::from(p));
    }
    #[cfg(target_os = "linux")]
    paths.push(PathBuf::from("libmpv.so.2"));
    paths
}

macro_rules! sym {
    ($lib:expr, $name:literal) => {
        *$lib.get(concat!($name, "\0").as_bytes()).map_err(|e| format!("libmpv is missing {}: {e}", $name))?
    };
}

fn load() -> Result<Api, String> {
    let mut errors = Vec::new();
    for path in candidate_paths() {
        if path.is_absolute() && !path.exists() {
            continue;
        }
        let lib = match unsafe { Library::new(&path) } {
            Ok(l) => l,
            Err(e) => {
                errors.push(format!("{}: {e}", path.display()));
                continue;
            }
        };
        unsafe {
            return Ok(Api {
                error_string: sym!(lib, "mpv_error_string"),
                free: sym!(lib, "mpv_free"),
                create: sym!(lib, "mpv_create"),
                initialize: sym!(lib, "mpv_initialize"),
                terminate_destroy: sym!(lib, "mpv_terminate_destroy"),
                set_option_string: sym!(lib, "mpv_set_option_string"),
                command: sym!(lib, "mpv_command"),
                set_property_string: sym!(lib, "mpv_set_property_string"),
                get_property_string: sym!(lib, "mpv_get_property_string"),
                observe_property: sym!(lib, "mpv_observe_property"),
                wait_event: sym!(lib, "mpv_wait_event"),
                render_context_create: sym!(lib, "mpv_render_context_create"),
                render_context_set_update_callback: sym!(lib, "mpv_render_context_set_update_callback"),
                render_context_update: sym!(lib, "mpv_render_context_update"),
                render_context_render: sym!(lib, "mpv_render_context_render"),
                render_context_free: sym!(lib, "mpv_render_context_free"),
                path,
                _lib: lib,
            });
        }
    }
    Err(if errors.is_empty() {
        "The built-in player engine (libmpv) was not found.".into()
    } else {
        format!("Couldn’t load libmpv: {}", errors.join("; "))
    })
}

static API: OnceLock<Result<Api, String>> = OnceLock::new();

pub fn api() -> Result<&'static Api, String> {
    API.get_or_init(load).as_ref().map_err(Clone::clone)
}

impl Api {
    pub fn err(&self, code: c_int) -> String {
        unsafe { CStr::from_ptr((self.error_string)(code)) }.to_string_lossy().into_owned()
    }

    pub fn check(&self, code: c_int, what: &str) -> Result<(), String> {
        if code < 0 {
            Err(format!("{what}: {}", self.err(code)))
        } else {
            Ok(())
        }
    }

    pub fn set_option(&self, h: *mut Handle, name: &str, value: &str) -> Result<(), String> {
        let (n, v) = (cstr(name), cstr(value));
        self.check(unsafe { (self.set_option_string)(h, n.as_ptr(), v.as_ptr()) }, &format!("option {name}"))
    }

    pub fn set_property(&self, h: *mut Handle, name: &str, value: &str) -> Result<(), String> {
        let (n, v) = (cstr(name), cstr(value));
        self.check(unsafe { (self.set_property_string)(h, n.as_ptr(), v.as_ptr()) }, &format!("property {name}"))
    }

    pub fn get_property(&self, h: *mut Handle, name: &str) -> Option<String> {
        let n = cstr(name);
        let p = unsafe { (self.get_property_string)(h, n.as_ptr()) };
        if p.is_null() {
            return None;
        }
        let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
        unsafe { (self.free)(p.cast()) };
        Some(s)
    }

    pub fn command(&self, h: *mut Handle, args: &[&str]) -> Result<(), String> {
        let owned: Vec<CString> = args.iter().map(|a| cstr(a)).collect();
        let mut ptrs: Vec<*const c_char> = owned.iter().map(|c| c.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        self.check(unsafe { (self.command)(h, ptrs.as_mut_ptr()) }, &format!("command {}", args.first().unwrap_or(&"")))
    }

    pub fn observe(&self, h: *mut Handle, id: u64, name: &str, format: c_int) {
        let n = cstr(name);
        unsafe { (self.observe_property)(h, id, n.as_ptr(), format) };
    }
}

pub fn cstr(s: &str) -> CString {
    CString::new(s.replace('\0', "")).unwrap()
}
