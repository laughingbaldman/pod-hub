//! Thin desktop shell. All logic lives in the React UI and the Hub server; this crate only
//! opens the window. Keep it that way so the same UI also runs in a LAN browser / Android.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the Hub window");
}
