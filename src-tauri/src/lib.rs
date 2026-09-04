mod ai;
mod error;
mod files;
mod media;
mod render;
mod settings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(render::RenderState::default())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            files::read_text_file,
            files::write_text_file,
            files::file_exists,
            files::startup_file,
            files::derive_paths,
            media::probe_media,
            media::compute_peaks,
            media::check_tools,
            settings::load_settings,
            settings::save_settings,
            settings::has_api_key,
            settings::set_api_key,
            settings::clear_api_key,
            ai::ai_continue,
            ai::list_models,
            render::render_burn_in,
            render::cancel_render,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
