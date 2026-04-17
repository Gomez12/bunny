use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri_plugin_store::StoreExt;

fn do_reset(app: &tauri::AppHandle) {
    if let Ok(store) = app.store("config.json") {
        let _ = store.delete("serverUrl");
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![reset_connection])
        .setup(|app| {
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

            let app_handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                if event.id().as_ref() == "reset_connection" {
                    do_reset(&app_handle);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Bunny client");
}
