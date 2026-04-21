use tauri::Manager;
use tauri::WebviewUrl;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::WebviewWindowBuilder;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;
use url::Url;

const STORE_FILE: &str = "config.json";
const SERVER_URL_KEY: &str = "serverUrl";

const EXTERNAL_LINK_INTERCEPT: &str = r#"
(function () {
  if (window.__bunnyExternalLinkPatched) return;
  window.__bunnyExternalLinkPatched = true;

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href) return;
    if (href.startsWith('#') || href.startsWith('javascript:')) return;
    var url;
    try { url = new URL(href, window.location.href); } catch (_) { return; }
    if (url.origin === window.location.origin) return;
    e.preventDefault();
    window.location.href = url.href;
  }, true);

  var nativeOpen = window.open;
  window.open = function (url) {
    if (typeof url === 'string') {
      try {
        var u = new URL(url, window.location.href);
        if (u.origin !== window.location.origin) {
          window.location.href = u.href;
          return null;
        }
      } catch (_) {}
    }
    return nativeOpen.apply(window, arguments);
  };
})();
"#;

fn do_reset(app: &tauri::AppHandle) {
    if let Ok(store) = app.store(STORE_FILE) {
        let _ = store.delete(SERVER_URL_KEY);
        let _ = store.save();
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("window.location.replace('index.html')");
    }
}

#[tauri::command]
fn reset_connection(app: tauri::AppHandle) {
    do_reset(&app);
}

fn saved_server_url(app: &tauri::AppHandle) -> Option<Url> {
    let store = app.store(STORE_FILE).ok()?;
    let value = store.get(SERVER_URL_KEY)?;
    let url_str = value.as_str()?.to_string();
    Url::parse(&url_str).ok()
}

fn is_internal(target: &Url, server: &Option<Url>) -> bool {
    let scheme = target.scheme();
    if matches!(scheme, "tauri" | "about" | "data" | "blob") {
        return true;
    }
    match target.host_str() {
        None => return true,
        Some("tauri.localhost") => return true,
        _ => {}
    }
    if let Some(server_url) = server {
        return target.scheme() == server_url.scheme()
            && target.host_str() == server_url.host_str()
            && target.port_or_known_default() == server_url.port_or_known_default();
    }
    false
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![reset_connection])
        .setup(|app| {
            let nav_handle = app.handle().clone();
            let menu_handle = app.handle().clone();

            let _window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("Bunny")
            .inner_size(1200.0, 800.0)
            .min_inner_size(800.0, 600.0)
            // Disable Tauri's native OS-level drop handler so HTML5
            // drag-and-drop inside the webview fires cleanly. Without this,
            // WKWebView on macOS never sees `dragenter`/`drop` because the
            // native window swallows the event first. We don't need the
            // native file-drop handler anywhere in the app.
            .disable_drag_drop_handler()
            .initialization_script(EXTERNAL_LINK_INTERCEPT)
            .on_navigation(move |url| {
                let server = saved_server_url(&nav_handle);
                if is_internal(url, &server) {
                    true
                } else {
                    let _ = nav_handle.opener().open_url(url.as_str(), None::<&str>);
                    false
                }
            })
            .build()?;

            let reset_item = MenuItemBuilder::with_id("reset_connection", "Reset Connection")
                .accelerator("CmdOrCtrl+Shift+R")
                .build(app)?;

            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&reset_item)
                .separator()
                .close_window()
                .build()?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&file_menu)
                .item(&edit_menu)
                .build()?;

            app.set_menu(menu)?;

            app.on_menu_event(move |_app, event| {
                if event.id().as_ref() == "reset_connection" {
                    do_reset(&menu_handle);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Bunny client");
}
