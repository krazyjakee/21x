//! Finite native window state and menu policy; no filesystem/caller authority.
use crate::production::contracts::object;
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub maximized: bool,
    pub fullscreen: bool,
}
fn integer(v: &Value, min: f64, max: f64) -> Option<f64> {
    v.as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0. && *n >= min && *n <= max)
}
impl WindowState {
    pub fn parse(v: &Value) -> Option<Self> {
        if !object(
            v,
            &[
                "version",
                "x",
                "y",
                "width",
                "height",
                "scale",
                "maximized",
                "fullscreen",
            ],
            &[],
        ) || v["version"] != 1
        {
            return None;
        }
        Some(Self {
            x: integer(&v["x"], -1_000_000., 1_000_000.)? as i32,
            y: integer(&v["y"], -1_000_000., 1_000_000.)? as i32,
            width: integer(&v["width"], 64., 32768.)? as u32,
            height: integer(&v["height"], 64., 32768.)? as u32,
            scale: v["scale"]
                .as_f64()
                .filter(|n| n.is_finite() && (0.5..=8.).contains(n))?,
            maximized: v["maximized"].as_bool()?,
            fullscreen: v["fullscreen"].as_bool()?,
        })
    }
    pub fn value(self) -> Value {
        json!({"version":1,"x":self.x,"y":self.y,"width":self.width,"height":self.height,"scale":self.scale,"maximized":self.maximized,"fullscreen":self.fullscreen})
    }
}
pub fn load_result(v: &Value) -> bool {
    object(v, &["state"], &[])
        && (v["state"].is_null() || WindowState::parse(&v["state"]).is_some())
}
pub fn save_request(v: &Value) -> bool {
    object(v, &["state"], &[]) && WindowState::parse(&v["state"]).is_some()
}

#[derive(Clone, Copy, Debug)]
pub struct MonitorArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}
impl MonitorArea {
    fn usable(self) -> bool {
        self.x.abs_diff(0) <= 1_000_000
            && self.y.abs_diff(0) <= 1_000_000
            && (64..=32768).contains(&self.width)
            && (64..=32768).contains(&self.height)
            && self.scale.is_finite()
            && (0.5..=8.).contains(&self.scale)
    }
    fn overlap(self, state: WindowState) -> i64 {
        let width = (i64::from(self.x) + i64::from(self.width))
            .min(i64::from(state.x) + i64::from(state.width))
            - i64::from(self.x).max(i64::from(state.x));
        let height = (i64::from(self.y) + i64::from(self.height))
            .min(i64::from(state.y) + i64::from(state.height))
            - i64::from(self.y).max(i64::from(state.y));
        width.max(0) * height.max(0)
    }
}
/// First monitor is the app-selected primary. A disconnected display cannot
/// strand the complete frame offscreen; DPI changes preserve logical size.
pub fn restore(saved: Option<WindowState>, monitors: &[MonitorArea]) -> WindowState {
    let fallback = MonitorArea {
        x: 0,
        y: 0,
        width: 1280,
        height: 850,
        scale: 1.,
    };
    let areas: Vec<_> = monitors
        .iter()
        .copied()
        .take(32)
        .filter(|m| m.usable())
        .collect();
    let primary = areas.first().copied().unwrap_or(fallback);
    let mut target = primary;
    let mut overlap = 0;
    if let Some(saved) = saved {
        for area in &areas {
            let amount = area.overlap(saved);
            if amount > overlap {
                overlap = amount;
                target = *area;
            }
        }
    }
    let initial = saved.unwrap_or(WindowState {
        x: target.x,
        y: target.y,
        width: 1400,
        height: 900,
        scale: 1.,
        maximized: false,
        fullscreen: false,
    });
    let resize = |dimension: u32, minimum: f64, maximum: u32| {
        ((f64::from(dimension) * target.scale / initial.scale).round() as u32).clamp(
            (minimum * target.scale).round().min(f64::from(maximum)) as u32,
            maximum,
        )
    };
    let (width, height) = (
        resize(initial.width, 900., target.width),
        resize(initial.height, 600., target.height),
    );
    let (x, y) = if overlap == 0 {
        (
            target.x + ((target.width - width) / 2) as i32,
            target.y + ((target.height - height) / 2) as i32,
        )
    } else {
        (
            initial
                .x
                .clamp(target.x, target.x + (target.width - width) as i32),
            initial
                .y
                .clamp(target.y, target.y + (target.height - height) as i32),
        )
    };
    WindowState {
        x,
        y,
        width,
        height,
        scale: target.scale,
        ..initial
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Reload,
    ZoomIn,
    ZoomOut,
    ZoomReset,
    Fullscreen,
    Minimize,
    Maximize,
    Close,
    Open,
    Quit,
}
impl Action {
    pub fn menu(id: &str) -> Option<Self> {
        Some(match id {
            "native.edit.undo" => Self::Undo,
            "native.edit.redo" => Self::Redo,
            "native.edit.cut" => Self::Cut,
            "native.edit.copy" => Self::Copy,
            "native.edit.paste" => Self::Paste,
            "native.edit.select-all" => Self::SelectAll,
            "native.view.reload" => Self::Reload,
            "native.view.zoom-in" => Self::ZoomIn,
            "native.view.zoom-out" => Self::ZoomOut,
            "native.view.zoom-reset" => Self::ZoomReset,
            "native.view.fullscreen" => Self::Fullscreen,
            "native.window.minimize" => Self::Minimize,
            "native.window.maximize" => Self::Maximize,
            "native.window.close" => Self::Close,
            "native.window.open" => Self::Open,
            "native.app.quit" => Self::Quit,
            _ => return None,
        })
    }
    pub fn editing_command(self) -> Option<&'static str> {
        match self {
            Self::Undo => Some("Undo"),
            Self::Redo => Some("Redo"),
            Self::Cut => Some("Cut"),
            Self::Copy => Some("Copy"),
            Self::Paste => Some("Paste"),
            Self::SelectAll => Some("SelectAll"),
            _ => None,
        }
    }
}
#[derive(Default)]
pub struct Zoom(i8);
impl Zoom {
    pub fn apply(&mut self, action: Action) -> Option<f64> {
        self.0 = match action {
            Action::ZoomIn => self.0.saturating_add(1).min(18),
            Action::ZoomOut => self.0.saturating_sub(1).max(-16),
            Action::ZoomReset => 0,
            _ => return None,
        };
        Some(1.2_f64.powf(f64::from(self.0) / 2.))
    }
}
pub fn overlay(v: &Value) -> bool {
    object(v, &["colors"], &[])
        && object(&v["colors"], &["color", "symbolColor"], &[])
        && ["color", "symbolColor"].iter().all(|key| {
            v["colors"][key].as_str().is_some_and(|s| {
                s.len() == 7
                    && s.starts_with('#')
                    && s.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> WindowState {
        WindowState {
            x: -1920,
            y: 100,
            width: 1400,
            height: 900,
            scale: 1.,
            maximized: true,
            fullscreen: false,
        }
    }
    fn primary() -> MonitorArea {
        MonitorArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            scale: 1.,
        }
    }
    #[test]
    fn disconnected_display_restores_visible_normal_bounds_and_retains_display_modes() {
        let restored = restore(Some(state()), &[primary()]);
        assert_eq!((restored.x, restored.y), (260, 90));
        assert!(restored.maximized);
        assert!(!restored.fullscreen);
        assert!(WindowState::parse(&restored.value()).is_some());
    }
    #[test]
    fn negative_secondary_and_dpi_change_preserve_size_without_offscreen_titlebar() {
        let secondary = MonitorArea {
            x: -3840,
            y: 0,
            width: 3840,
            height: 2160,
            scale: 2.,
        };
        let restored = restore(Some(state()), &[primary(), secondary]);
        assert_eq!(
            (restored.width, restored.height, restored.scale),
            (2800, 1800, 2.)
        );
        assert!(restored.x >= secondary.x && restored.x + restored.width as i32 <= 0);
        assert!(restored.y >= 0 && restored.y + restored.height as i32 <= 2160);
    }
    #[test]
    fn small_and_invalid_monitors_cannot_invent_unbounded_geometry() {
        let small = MonitorArea {
            x: 0,
            y: 0,
            width: 800,
            height: 480,
            scale: 1.,
        };
        let restored = restore(
            Some(state()),
            &[
                MonitorArea {
                    scale: f64::NAN,
                    ..primary()
                },
                small,
            ],
        );
        assert_eq!(
            (restored.width, restored.height, restored.x, restored.y),
            (800, 480, 0, 0)
        );
        assert!(WindowState::parse(&restore(None, &[]).value()).is_some());
        for invalid in [
            json!({"path":"/private"}),
            json!({"state":state().value(),"profileId":"foreign"}),
        ] {
            assert!(!save_request(&invalid));
        }
        let mut invalid = state().value();
        invalid["width"] = json!(0);
        assert!(WindowState::parse(&invalid).is_none());
    }
    #[test]
    fn menu_zoom_is_finite_bounded_and_resets_only_on_explicit_action() {
        assert_eq!(Action::menu("native.edit.copy"), Some(Action::Copy));
        assert!(Action::menu("renderer:eval").is_none());
        let mut zoom = Zoom::default();
        for _ in 0..200 {
            zoom.apply(Action::ZoomIn);
        }
        assert!((zoom.apply(Action::ZoomIn).unwrap() - 1.2_f64.powf(9.)).abs() < 1e-10);
        for _ in 0..200 {
            zoom.apply(Action::ZoomOut);
        }
        assert!((zoom.apply(Action::ZoomOut).unwrap() - 1.2_f64.powf(-8.)).abs() < 1e-10);
        assert_eq!(zoom.apply(Action::ZoomReset), Some(1.));
        assert_eq!(zoom.apply(Action::Copy), None);
        assert!(overlay(
            &json!({"colors":{"color":"#141414","symbolColor":"#8e8d91"}})
        ));
        assert!(!overlay(
            &json!({"colors":{"color":"red;url(private)","symbolColor":"#8e8d91"}})
        ));
    }
}
