#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;

const CORE_BYTES: &[u8] = include_bytes!("../../dist/minecraft-bot.exe");
const CORE_NAME: &str = "minecraft-bot-core.exe";
const CREATE_NO_WINDOW: u32 = 0x08000000;
const DETACHED_PROCESS: u32 = 0x00000008;
const DEFAULT_PORT: u16 = 8787;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

fn core_dir() -> PathBuf {
    let base = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir());
    base.join("minecraft-bot").join("core")
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn hash_file(path: &Path) -> std::io::Result<u64> {
    let mut file = fs::File::open(path)?;
    let mut hash: u64 = 0xcbf29ce484222325;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            hash ^= b as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    Ok(hash)
}

fn ensure_core() -> std::io::Result<PathBuf> {
    let dir = core_dir();
    fs::create_dir_all(&dir)?;
    let exe = dir.join(CORE_NAME);
    let expected_hash = fnv1a64(CORE_BYTES);
    let already_current = fs::metadata(&exe)
        .map(|m| m.len() == CORE_BYTES.len() as u64)
        .unwrap_or(false)
        && hash_file(&exe).map(|h| h == expected_hash).unwrap_or(false);
    if !already_current {
        fs::write(&exe, CORE_BYTES)?;
    }
    Ok(exe)
}

fn read_port(dir: &Path) -> u16 {
    let path = dir.join("config.json");
    if let Ok(text) = fs::read_to_string(path) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(port) = value
                .get("api")
                .and_then(|api| api.get("port"))
                .and_then(|port| port.as_u64())
            {
                return port.min(u16::MAX as u64) as u16;
            }
        }
    }
    DEFAULT_PORT
}

fn http_ready(port: u16) -> bool {
    let addr = match format!("127.0.0.1:{port}").to_socket_addrs() {
        Ok(mut addrs) => addrs.next(),
        Err(_) => None,
    };
    let Some(addr) = addr else {
        return false;
    };

    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else {
        return false;
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let request = format!(
        "GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    match stream.read(&mut buf) {
        Ok(n) if n >= 12 => String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200"),
        _ => false,
    }
}

fn spawn_core(exe: &Path, dir: &Path) -> std::io::Result<Child> {
    Command::new(exe)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
}

fn open_in_browser(url: &str) {
    let _ = Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

fn stop_child(child: &mut Option<Child>) {
    if let Some(mut child) = child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn main() -> wry::Result<()> {
    let dir = core_dir();
    fs::create_dir_all(&dir).ok();
    let port = read_port(&dir);
    let url = format!("http://127.0.0.1:{port}");

    let mut child: Option<Child> = None;

    if !http_ready(port) {
        match ensure_core() {
            Ok(exe) => {
                match spawn_core(&exe, &dir) {
                    Ok(spawned) => {
                        child = Some(spawned);
                    }
                    Err(_) => {
                        // Try the existing packaged core next to this launcher as a fallback.
                        if let Ok(current_exe) = env::current_exe() {
                            if let Some(base) = current_exe.parent() {
                                let sibling = base.join("minecraft-bot.exe");
                                if sibling.exists() {
                                    if let Ok(spawned) = spawn_core(&sibling, base) {
                                        child = Some(spawned);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(_) => {}
        }

        let deadline = Instant::now() + STARTUP_TIMEOUT;
        while !http_ready(port) {
            if Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(300));
        }
    }

    if !http_ready(port) {
        stop_child(&mut child);
        panic!("核心服务启动失败，请检查 8787 端口是否被占用或 WebView2 是否可用");
    }

    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Minecraft AI Bot")
        .with_inner_size(tao::dpi::LogicalSize::new(1180.0, 800.0))
        .build(&event_loop)
        .expect("创建窗口失败");

    let _webview = WebViewBuilder::new().with_url(&url).build(&window).ok();

    if _webview.is_none() {
        // Rare path: WebView2 Runtime is missing. Fall back to the default browser.
        window.set_title("已用默认浏览器打开控制面板，关闭本窗口将停止服务");
        open_in_browser(&url);
    }

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            stop_child(&mut child);
            *control_flow = ControlFlow::Exit;
        }
    });

}




