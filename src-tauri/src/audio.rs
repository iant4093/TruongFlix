//! Audio outputs for the built-in player: the device list (as mpv names them) and the system's
//! current default device, so per-device settings (like Bluetooth audio delay) follow the
//! speakers actually in use when the player is set to "System default".

use crate::media::Core;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    /// mpv device name, e.g. "coreaudio/BuiltInSpeakerDevice" or "wasapi/{0.0.0.00000000}.{…}".
    pub name: String,
    pub description: String,
}

/// Outputs mpv can play to ("auto" first).
#[tauri::command]
pub async fn audio_devices() -> Result<Vec<AudioDevice>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let core = Core::new(&[("vo", "null"), ("vid", "no")])?;
        let json = core.get("audio-device-list").unwrap_or_else(|| "[]".into());
        let list: Vec<AudioDevice> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        // macOS lists each device twice (CoreAudio and AVFoundation); keep the CoreAudio ones.
        Ok(list.into_iter().filter(|d| !d.name.starts_with("avfoundation/")).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The system's current default output, named the way mpv names it.
#[tauri::command]
pub fn default_audio_device() -> Option<AudioDevice> {
    platform::default_device()
}

#[cfg(target_os = "macos")]
mod platform {
    use super::AudioDevice;
    use objc2_foundation::NSString;
    use std::ffi::c_void;

    #[repr(C)]
    struct PropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyData(
            id: u32,
            address: *const PropertyAddress,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
            data: *mut c_void,
        ) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    const fn fourcc(s: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*s)
    }
    const SYSTEM_OBJECT: u32 = 1;
    const GLOBAL: u32 = fourcc(b"glob");

    unsafe fn string_property(device: u32, selector: u32) -> Option<String> {
        let address = PropertyAddress { selector, scope: GLOBAL, element: 0 };
        let mut cf: *const c_void = std::ptr::null();
        let mut size = std::mem::size_of::<*const c_void>() as u32;
        let status = AudioObjectGetPropertyData(device, &address, 0, std::ptr::null(), &mut size, &mut cf as *mut _ as *mut c_void);
        if status != 0 || cf.is_null() {
            return None;
        }
        // CFStringRef is toll-free bridged with NSString.
        let text = (*(cf as *const NSString)).to_string();
        CFRelease(cf);
        Some(text)
    }

    pub fn default_device() -> Option<AudioDevice> {
        unsafe {
            let address = PropertyAddress { selector: fourcc(b"dOut"), scope: GLOBAL, element: 0 };
            let mut device: u32 = 0;
            let mut size = std::mem::size_of::<u32>() as u32;
            let status = AudioObjectGetPropertyData(SYSTEM_OBJECT, &address, 0, std::ptr::null(), &mut size, &mut device as *mut u32 as *mut c_void);
            if status != 0 || device == 0 {
                return None;
            }
            let uid = string_property(device, fourcc(b"uid "))?;
            let name = string_property(device, fourcc(b"lnam")).unwrap_or_else(|| uid.clone());
            Some(AudioDevice { name: format!("coreaudio/{uid}"), description: name })
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::AudioDevice;
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};

    pub fn default_device() -> Option<AudioDevice> {
        // Own thread: COM is initialised as multithreaded there, independent of the UI thread.
        std::thread::spawn(|| unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
            let id = device.GetId().ok()?;
            let text = id.to_string().ok();
            CoTaskMemFree(Some(id.0 as *const _));
            let id = text?;
            Some(AudioDevice { name: format!("wasapi/{id}"), description: String::new() })
        })
        .join()
        .ok()
        .flatten()
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::AudioDevice;
    pub fn default_device() -> Option<AudioDevice> {
        None
    }
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore]
    fn lists_real_devices() {
        println!("default: {:?}", super::default_audio_device());
        println!("all: {:?}", tauri::async_runtime::block_on(super::audio_devices()));
    }
}
