//! Native-only OAuth bridge. The preview never registers or steals OS schemes.
use super::{available_engine, native_services::NativeWorkOwner, ProductionState};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use twentyonex_engine::{
    production::ProductionOAuthHost, production_oauth::OAuthAuthority, EngineError,
};

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
