//! Plays a video through the built-in player's render path and reports what was drawn.
//! `TRUONGFLIX_PLAYER_PROBE=1 cargo run --example player_smoke -- /path/to/video.mkv`

#[cfg(target_os = "macos")]
fn main() {
    let path = std::env::args().nth(1).expect("usage: player_smoke <video>");
    match truongflix_lib::player_smoke_test(&path, 5.0) {
        Ok(report) => println!("OK: {report}"),
        Err(e) => {
            eprintln!("FAILED: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("The built-in player smoke test currently runs on macOS only.");
}
