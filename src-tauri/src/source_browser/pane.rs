//! Positions the isolated source view inside the trusted title dialog without exposing remote IPC.
use super::*;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub viewport_width: f64,
    pub viewport_height: f64,
}
impl PaneRect {
    fn clipped(self) -> Result<Option<Self>, String> {
        let values = [
            self.x,
            self.y,
            self.width,
            self.height,
            self.viewport_width,
            self.viewport_height,
        ];
        if values.iter().any(|v| !v.is_finite() || v.abs() > 30_000.0)
            || self.width < 0.0
            || self.height < 0.0
            || self.viewport_width < 320.0
            || self.viewport_height < 200.0
        {
            return Err("Invalid verification panel bounds".into());
        }
        // Keep the title's close control and the window's own controls outside the native view.
        let x = self.x.max(0.0);
        let y = self.y.max(64.0);
        let width = (self.x + self.width).min(self.viewport_width) - x;
        let height = (self.y + self.height).min(self.viewport_height - 8.0) - y;
        Ok((width >= 80.0 && height >= 80.0).then_some(Self {
            x,
            y,
            width,
            height,
            ..self
        }))
    }
}

#[cfg(target_os = "macos")]
use super::macos as platform;
#[cfg(target_os = "windows")]
use super::windows as platform;

pub async fn hide(browser: &WebviewWindow, detach: bool) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        browser
            .with_webview(move |view| {
                let _ = tx.send(platform::hide_pane(&view, detach));
            })
            .map_err(|e| e.to_string())?;
        return tokio::time::timeout(std::time::Duration::from_secs(3), rx)
            .await
            .map_err(|_| "Verification panel did not close in time")?
            .map_err(|_| "Verification panel is closed")?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (browser, detach);
        Ok(())
    }
}

#[tauri::command]
pub async fn source_browser_place(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    rect: Option<PaneRect>,
) -> Result<(), String> {
    main_only(&window)?;
    let rect = rect.map(PaneRect::clipped).transpose()?.flatten();
    let allowed = {
        let state = app.state::<SourceState>();
        let guard = state.0.lock().unwrap();
        guard.as_ref().is_some_and(|s| {
            s.request_id == request_id && !s.manual && (rect.is_none() || s.challenge_shown)
        })
    };
    if !allowed {
        return Ok(());
    }
    let Some(browser) = app.get_webview_window(LABEL) else {
        return Ok(());
    };
    let Some(rect) = rect else {
        return hide(&browser, false).await;
    };
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |parent| match platform::pane_parent(&parent) {
                Err(error) => {
                    let _ = tx.send(Err(error));
                }
                Ok(parent) => {
                    let _ = browser.with_webview(move |view| {
                        let current = app
                            .state::<SourceState>()
                            .0
                            .lock()
                            .unwrap()
                            .as_ref()
                            .is_some_and(|s| {
                                s.request_id == request_id && !s.manual && s.challenge_shown
                            });
                        let result = if current {
                            platform::place_pane(&view, parent, rect)
                        } else {
                            platform::hide_pane(&view, false)
                        };
                        let _ = tx.send(result);
                    });
                }
            })
            .map_err(|e| e.to_string())?;
        return tokio::time::timeout(std::time::Duration::from_secs(3), rx)
            .await
            .map_err(|_| "Verification panel could not be displayed")?
            .map_err(|_| "Verification panel is closed")?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, browser, rect);
        Err("Inline verification is unavailable on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rect() -> PaneRect {
        PaneRect {
            x: 20.0,
            y: 150.0,
            width: 800.0,
            height: 360.0,
            viewport_width: 960.0,
            viewport_height: 600.0,
        }
    }
    #[test]
    fn keeps_verification_inside_the_visible_dialog_area() {
        let clipped = PaneRect {
            y: -50.0,
            height: 800.0,
            ..rect()
        }
        .clipped()
        .unwrap()
        .unwrap();
        assert_eq!(clipped.y, 64.0);
        assert_eq!(clipped.y + clipped.height, 592.0);
        assert!(PaneRect { y: 800.0, ..rect() }.clipped().unwrap().is_none());
        assert!(PaneRect {
            width: f64::NAN,
            ..rect()
        }
        .clipped()
        .is_err());
    }
}
