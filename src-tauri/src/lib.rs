mod ai;
mod dictionary;
mod engine;
mod error;
mod files;
mod media;
mod project_state;
mod proofread;
mod render;
mod settings;
mod spelling;
mod transcribe;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(render::RenderState::default())
        .manage(spelling::SpellState::default())
        .manage(proofread::ProofreadState::default())
        .manage(transcribe::TranscribeState::default())
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
            project_state::load_app_state,
            project_state::remember_project,
            project_state::remember_position,
            project_state::forget_project,
            project_state::clear_last_project,
            ai::ai_continue,
            ai::list_models,
            render::render_burn_in,
            render::cancel_render,
            spelling::check_cues,
            proofread::ai_proofread,
            proofread::cancel_proofread,
            dictionary::load_user_dictionary,
            dictionary::save_user_dictionary,
            transcribe::transcribe_status,
            transcribe::install_engine,
            transcribe::transcribe_video,
            transcribe::cancel_transcribe,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
