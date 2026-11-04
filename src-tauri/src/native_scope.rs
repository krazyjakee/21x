//! Linux process containment without manual setup.
//!
//! The production engine needs a delegated cgroup-v2 directory to contain the
//! Node service and every agent it starts. A packaged or terminal launch has
//! none, so before any thread or window starts, the host asks the user's
//! systemd manager to move this process into its own transient scope with
//! `Delegate=yes` (what `systemd-run --user --scope -p Delegate=yes` does).
//! An explicit `TWENTYONEX_PRODUCTION_CGROUP_ROOT` still wins. When systemd is
//! unavailable, startup reports containment as unavailable, as before.
use std::path::PathBuf;

const OVERRIDE: &str = "TWENTYONEX_PRODUCTION_CGROUP_ROOT";

/// The delegation root, provisioned once at process start.
pub fn delegation_root() -> Option<PathBuf> {
    static ROOT: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    ROOT.get_or_init(provision).clone()
}

fn provision() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(OVERRIDE) {
        return Some(PathBuf::from(path));
    }
    let unit = format!("twentyonex-{}.scope", std::process::id());
    if !own_cgroup()?.ends_with(&format!("/{unit}")) {
        start_scope(&unit)?;
        // The move is applied by systemd's job; observe it rather than trust the reply.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !own_cgroup()?.ends_with(&format!("/{unit}")) {
            if std::time::Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    Some(PathBuf::from(format!("/sys/fs/cgroup{}", own_cgroup()?)))
}

/// This process's cgroup-v2 path (the `0::` line), if the host uses v2.
fn own_cgroup() -> Option<String> {
    let text = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    let path = text.lines().find_map(|line| line.strip_prefix("0::"))?;
    (path.starts_with('/') && !path.contains("..")).then(|| path.to_owned())
}

fn start_scope(unit: &str) -> Option<()> {
    use gtk::{gio, glib};
    let bus = gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>).ok()?;
    let parameters = glib::Variant::parse(
        Some(glib::VariantTy::new("(ssa(sv)a(sa(sv)))").ok()?),
        &format!(
            "('{unit}', 'fail', [('PIDs', <[uint32 {pid}]>), ('Delegate', <true>), \
             ('CollectMode', <'inactive-or-failed'>), ('Description', <'21x agent containment'>)], \
             @a(sa(sv)) [])",
            pid = std::process::id()
        ),
    )
    .ok()?;
    bus.call_sync(
        Some("org.freedesktop.systemd1"),
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "StartTransientUnit",
        Some(&parameters),
        Some(glib::VariantTy::new("(o)").ok()?),
        gio::DBusCallFlags::NONE,
        5_000,
        None::<&gio::Cancellable>,
    )
    .ok()?;
    Some(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_the_unified_cgroup_line() {
        let path = super::own_cgroup().expect("cgroup v2 test host");
        assert!(path.starts_with('/'));
    }
}
