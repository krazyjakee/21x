//! Native-only OAuth bridge. The preview never registers or steals OS schemes.
use super::{available_engine, native_services::NativeWorkOwner, ProductionState};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use twentyonex_engine::{
    production::ProductionOAuthHost, production_oauth::OAuthAuthority, EngineError,
};

#[cfg(target_os = "linux")]
pub fn instance_bus_id(identifier: &str) -> String {
    use sha2::{Digest, Sha256};
    // Bundle IDs can contain numeric/hyphenated segments invalid for D-Bus.
    // Hash the configured identity, without choosing a final application ID.
    format!(
        "org.twentyonex.Callback.i{:x}",
        Sha256::digest(identifier.as_bytes())
    )
}

#[cfg(target_os = "linux")]
fn bounded_instance_plugin<R: tauri::Runtime, F>(
    identifier: &str,
    mut deliver: F,
) -> tauri::plugin::TauriPlugin<R>
where
    F: FnMut(&tauri::AppHandle<R>, &str) + Send + Sync + 'static,
{
    tauri_plugin_single_instance::Builder::new()
        .dbus_id(instance_bus_id(identifier))
        .callback(move |app, arguments, _untrusted_cwd| {
            if let Some(raw) = twentyonex_engine::production_oauth::callback_argument(&arguments) {
                deliver(app, raw);
            }
        })
        .build()
}

#[cfg(target_os = "linux")]
pub fn single_instance(identifier: &str) -> tauri::plugin::TauriPlugin<tauri::Wry> {
    bounded_instance_plugin(identifier, |app, raw| {
        if let Some(state) = app.try_state::<ProductionState>() {
            let _ = state.oauth.forward(app, raw);
        }
    })
}

#[derive(Clone)]
pub struct NativeOAuthOwner {
    authority: OAuthAuthority,
    epoch: Arc<Mutex<Option<String>>>,
}
impl Default for NativeOAuthOwner {
    fn default() -> Self {
        // Final application identity/registration authority remains undecided.
        Self {
            authority: OAuthAuthority::new(false),
            epoch: Arc::new(Mutex::new(None)),
        }
    }
}
impl NativeOAuthOwner {
    #[cfg(target_os = "linux")]
    fn forward(&self, app: &tauri::AppHandle, raw: &str) -> Result<(), EngineError> {
        let epoch = self
            .epoch
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?
            .clone()
            .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
        let state = app.state::<ProductionState>();
        state.native_work.assert_open()?;
        let engine = available_engine(app, Some(&epoch))?;
        let receipt = self.authority.begin_delivery(raw)?;
        // This independently retained permit joins the raw private claim RPC.
        // Neither browser lifetime nor token exchange is part of this receipt.
        tauri::async_runtime::spawn(async move {
            let _ = engine
                .deliver_oauth(&epoch, receipt.payload().clone())
                .await;
            drop(receipt);
        });
        Ok(())
    }

    pub fn reject_cold_callback(&self, arguments: &[String]) {
        if twentyonex_engine::production_oauth::callback_argument(arguments).is_some() {
            // There is no persisted encrypted PKCE/source intent to resume.
            // Do not queue a code for reconstruction by a later Source lease.
            eprintln!("PRODUCTION_OAUTH_FRESH_CONNECT_REQUIRED");
        }
    }
    fn bind_epoch(&self, epoch: &str) -> Result<(), EngineError> {
        let mut bound = self
            .epoch
            .lock()
            .map_err(|_| EngineError::new("DISCONNECTED"))?;
        if bound.as_ref().is_some_and(|value| value != epoch) {
            return Err(EngineError::new("STALE_EPOCH"));
        }
        *bound = Some(epoch.into());
        Ok(())
    }
    pub fn stop(&self) -> Result<(), EngineError> {
        self.authority.stop()
    }
    pub fn host(&self, app: &tauri::AppHandle, work: NativeWorkOwner) -> ProductionOAuthHost {
        let (owner, closing, app) = (self.clone(), self.clone(), app.clone());
        ProductionOAuthHost {
            invoke: Arc::new(move |operation, payload, epoch| {
                let (owner, app, work) = (owner.clone(), app.clone(), work.clone());
                Box::pin(async move {
                    owner.bind_epoch(&epoch)?;
                    if operation == "host.oauth.retire" {
                        // Cleanup survives normal native admission closure.
                        return owner
                            .authority
                            .retire(
                                payload["flowId"]
                                    .as_str()
                                    .ok_or_else(|| EngineError::new("INVALID_ARGUMENTS"))?,
                            )
                            .await;
                    }
                    work.assert_open()?;
                    available_engine(&app, Some(&epoch))?;
                    if operation == "host.oauth.register" {
                        return owner.authority.register(&payload);
                    }
                    if operation != "host.oauth.open" {
                        return Err(EngineError::new("UNKNOWN_OPERATION"));
                    }
                    let id = payload["flowId"]
                        .as_str()
                        .ok_or_else(|| EngineError::new("INVALID_ARGUMENTS"))?
                        .to_owned();
                    let receipt = owner.authority.begin_open(&id)?;
                    let window = app
                        .get_webview_window("main")
                        .ok_or_else(|| EngineError::new("DISCONNECTED"))?;
                    let checking = work.clone();
                    work.run(move || {
                        // The permit stays in raw work after a public timeout.
                        let receipt = receipt;
                        checking.assert_open()?;
                        available_engine(&app, Some(&epoch))?;
                        app.state::<ProductionState>().ui.assert_window(&window)?;
                        let url = receipt.payload()["url"]
                            .as_str()
                            .ok_or_else(|| EngineError::new("INVALID_ARGUMENTS"))?;
                        app.opener()
                            .open_url(url, None::<String>)
                            .map_err(|_| EngineError::new("DISCONNECTED"))
                    })
                    .await?;
                    Ok(json!({"flowId":id,"opened":true}))
                })
            }),
            close: Arc::new(move || {
                let owner = closing.clone();
                Box::pin(async move { owner.authority.close().await })
            }),
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use gtk::glib::variant::ToVariant;
    use std::{
        process::Command,
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        time::Duration,
    };
    use tauri::{
        test::{mock_builder, mock_context, noop_assets},
        Listener,
    };

    fn opened(owner: &OAuthAuthority, id: &str, nonce: &str, uri: &str) {
        use sha2::{Digest, Sha256};
        owner
            .register(&json!({
                "flowId":id,
                "kind":"custom-scheme",
                "stateSha256":format!("{:x}",Sha256::digest(nonce.as_bytes())),
                "redirectUri":uri,
                "authorizationUrl":format!("https://provider.example/auth?state={nonce}&redirect_uri={uri}"),
                "ttlMs":300000,
            }))
            .unwrap();
        drop(owner.begin_open(id).unwrap());
    }

    #[test]
    fn warm_forwarding_uses_private_bus_and_nonce_authority() {
        const CHILD: &str = "TWENTYONEX_NATIVE_OAUTH_BUS_PARENT";
        if std::env::var(CHILD)
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .is_none_or(|parent| parent == std::process::id())
        {
            // The same test is its own bounded subprocess fixture. Never borrow
            // the user's session bus, clipboard, installed schemes or profile.
            let output = Command::new("timeout").args(["--kill-after=2s", "20s", "dbus-run-session", "--"])
                .arg(std::env::current_exe().unwrap())
                .args(["--exact", "production_host::native_oauth::tests::warm_forwarding_uses_private_bus_and_nonce_authority", "--nocapture", "--test-threads=1"])
                .env(CHILD, std::process::id().to_string()).output().unwrap();
            assert!(
                output.status.success(),
                "isolated native callback fixture failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
            return;
        }
        let identifier = "com.krazyjakee.21x.tauri-production-preview-fixture";
        let name = format!("{}.SingleInstance", instance_bus_id(identifier));
        let path = format!("/{}", name.replace('.', "/"));
        let owner = OAuthAuthority::new(true); // Synthetic native registration authority only.
        let nonce = "synthetic_nonce_0123456789";
        let id = "bdf2af85-5898-414c-a64c-27c38ce72eb2";
        opened(&owner, id, nonce, "twentyonex://oauth/callback");
        let accepting = owner.clone();
        let (sent, received) = mpsc::channel();
        let plugin = bounded_instance_plugin(identifier, move |_app, raw| {
            if let Ok(receipt) = accepting.begin_delivery(raw) {
                assert!(sent.send(receipt.payload().clone()).is_ok());
            }
        });
        let mut context = mock_context(noop_assets());
        context.config_mut().identifier = identifier.into();
        let app = mock_builder().plugin(plugin).build(context).unwrap();
        let public_events = Arc::new(AtomicUsize::new(0));
        let observed = public_events.clone();
        app.listen_any("deep-link://new-url", move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
        });
        let bus =
            gtk::gio::bus_get_sync(gtk::gio::BusType::Session, None::<&gtk::gio::Cancellable>)
                .unwrap();
        let invoke = |args: Vec<String>| {
            let parameters = (args, "/untrusted/cwd/ignored").to_variant();
            let result = bus.call_sync(
                Some(&name),
                &path,
                "org.SingleInstance.DBus",
                "ExecuteCallback",
                Some(&parameters),
                None,
                gtk::gio::DBusCallFlags::NONE,
                1000,
                None::<&gtk::gio::Cancellable>,
            );
            assert!(result.is_ok(), "native callback transport refused fixture");
        };
        let raw = format!("twentyonex://oauth/callback?state={nonce}&code=synthetic-code");
        invoke(vec![
            "ignored executable".into(),
            raw.replace(nonce, "foreign_nonce_0123456789"),
        ]);
        invoke(vec!["ignored executable".into(), raw.clone(), raw.clone()]);
        invoke(vec![
            "ignored executable".into(),
            raw.clone() + "&sourceId=foreign",
        ]);
        assert!(received.try_recv().is_err());
        invoke(vec!["ignored executable".into(), raw.clone()]);
        let payload = received.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(twentyonex_engine::production_oauth::callback(&payload));
        assert!(payload["flowId"] == id && payload["outcome"]["status"] == "code");
        invoke(vec!["ignored executable".into(), raw]);
        assert!(received.try_recv().is_err());
        let legacy_id = "cdf2af85-5898-414c-a64c-27c38ce72eb2";
        let legacy_nonce = "legacy_nonce_0123456789";
        opened(&owner, legacy_id, legacy_nonce, "nuanu://oauth/callback");
        let denial = format!("nuanu://oauth/callback?state={legacy_nonce}&error=access_denied&error_description=synthetic-private-description");
        invoke(vec!["ignored executable".into(), denial.clone()]);
        let payload = received.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(twentyonex_engine::production_oauth::callback(&payload));
        assert_eq!(payload["flowId"], legacy_id);
        assert_eq!(payload["outcome"], json!({"status":"denied"}));
        invoke(vec!["ignored executable".into(), denial.clone()]);
        assert!(received.try_recv().is_err());
        assert_eq!(public_events.load(Ordering::SeqCst), 0);
        let stopped_nonce = "stopped_nonce_0123456789";
        opened(
            &owner,
            "ddf2af85-5898-414c-a64c-27c38ce72eb2",
            stopped_nonce,
            "twentyonex://oauth/callback",
        );
        owner.stop().unwrap();
        invoke(vec![
            "ignored executable".into(),
            format!("twentyonex://oauth/callback?state={stopped_nonce}&code=synthetic-code"),
        ]);
        assert!(received.try_recv().is_err());
        tauri::async_runtime::block_on(owner.close()).unwrap();
        invoke(vec!["ignored executable".into(), denial]);
        assert!(received.try_recv().is_err());
        app.cleanup_before_exit();
    }
    #[test]
    fn configured_id_maps_to_valid_unambiguous_private_bus_name() {
        let left = instance_bus_id("com.krazyjakee.21x.tauri-production-preview");
        assert!(left
            .split('.')
            .all(|s| s.as_bytes()[0].is_ascii_alphabetic()
                && s.bytes().all(|b| b.is_ascii_alphanumeric())));
        assert_ne!(
            left,
            instance_bus_id("com.krazyjakee.21x.tauri_production_preview")
        );
    }
}
