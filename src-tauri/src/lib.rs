mod agent;
mod ai;
mod beats;
mod chat;
mod dictionary;
mod direct;
mod engine;
mod error;
mod files;
mod fill;
mod ghost;
mod media;
mod mixdown;
mod project_state;
mod proofread;
mod render;
mod settings;
mod spelling;
mod transcribe;
mod tts;
mod vision;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(render::RenderState::default())
        .manage(mixdown::MixdownState::default())
        .manage(tts::TtsState::default())
        .manage(spelling::SpellState::default())
        .manage(proofread::ProofreadState::default())
        .manage(transcribe::TranscribeState::default())
        .manage(ghost::GhostState::default())
        .manage(chat::ChatState::default())
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
            files::voiceover_unused_files,
            files::voiceover_trash_files,
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
            ai::list_models,
            agent::ai_agent_step,
            vision::ai_describe_frame,
            beats::ai_story_beats,
            direct::ai_direct_line,
            fill::ai_fill,
            ghost::ai_ghost,
            ghost::cancel_ghost,
            chat::ai_chat,
            chat::cancel_chat,
            render::render_burn_in,
            render::cancel_render,
            mixdown::mixdown_voiceover,
            mixdown::cancel_mixdown,
            tts::tts_status,
            tts::install_tts,
            tts::cancel_tts_install,
            tts::tts_generate,
            tts::tts_unload,
            tts::tts_extract_reference,
            tts::tts_stretch,
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
