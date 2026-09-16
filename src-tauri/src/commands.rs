//! Tauri IPC 命令：原生文件操作 + 转发到 Node sidecar 的 REST API。

use crate::sidecar::SidecarState;
use serde::Serialize;
use serde_json::json;
use std::fs;
use std::time::Duration;
use tauri::{Manager, State};

fn base(port: u16) -> Result<String, String> {
    if port == 0 {
        return Err("sidecar 未就绪，请重启应用".into());
    }
    Ok(format!("http://127.0.0.1:{port}"))
}

fn get_json(port: u16, path: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}{path}", base(port)?);
    reqwest::blocking::get(&url)
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .map_err(|e| e.to_string())
}

fn post_json(port: u16, path: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let url = format!("{}{path}", base(port)?);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    client
        .post(&url)
        .json(&body)
        .send()
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .map_err(|e| e.to_string())
}

// ---------- 服务健康 ----------

#[tauri::command]
pub fn sidecar_health(state: State<SidecarState>) -> Result<serde_json::Value, String> {
    get_json(state.port(), "/health")
}

#[tauri::command]
pub fn sidecar_port(state: State<SidecarState>) -> u16 {
    state.port()
}

// ---------- 窗口生命周期（关闭确认对话框选项） ----------

/// 最小化到托盘：隐藏窗口，sidecar 继续后台运行
#[tauri::command]
pub fn minimize_to_tray(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// 退出程序：sidecar 由父进程 watchdog（MRSLIY_PARENT_PID）自动跟随退出
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 启动新版本安装器并退出当前应用（自动更新流程的最后一步）。
/// 安装器路径必须位于 ~/.mr-sliy/updates 目录内且为 .exe，防止任意进程启动。
///
/// 启动健壮性(实测 os error 193 偶发于 AV 实时扫描锁住镜像读取/系统层对 verbatim
/// 路径的兼容性问题——文件本身 sha256 完好):
/// 1. PE 头校验,损坏直接报错而非给出误导性的系统错误
/// 2. canonicalize 的 \\?\ 前缀去除后再 spawn
/// 3. 直接启动失败 → 短暂等待重试(缓解 AV 扫描窗口) → cmd start 兜底(ShellExecute 语义)
/// 4. 每次尝试写入 installer.log,失败可事后诊断
#[tauri::command]
pub fn install_update(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::io::Read;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0000_0800;

    let updates_dir = std::env::var("USERPROFILE")
        .map_err(|_| "no USERPROFILE".to_string())
        .map(std::path::PathBuf::from)?
        .join(".mr-sliy")
        .join("updates");
    let updates_dir = updates_dir.canonicalize().map_err(|e| format!("updates 目录不存在: {e}"))?;
    let exe = std::path::Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("安装包不存在: {e}"))?;

    // canonicalize 在 Windows 返回 \\?\ 前缀路径，两侧统一后再做前缀比对
    let dir_str = updates_dir.to_string_lossy().to_lowercase();
    let exe_str = exe.to_string_lossy().to_lowercase();
    if !exe_str.starts_with(&dir_str) {
        return Err("安装包路径不在更新目录内".into());
    }
    if exe.extension().map(|e| e.to_ascii_lowercase()) != Some("exe".into()) {
        return Err("仅允许启动 .exe 安装包".into());
    }

    // 去除 \\?\ verbatim 前缀(CreateProcess 对该前缀在部分系统层存在兼容性问题)
    fn deverbatim(p: &std::path::Path) -> std::path::PathBuf {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            std::path::PathBuf::from(format!(r"\\{rest}"))
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            std::path::PathBuf::from(rest)
        } else {
            p.to_path_buf()
        }
    }
    let exe_plain = deverbatim(&exe);

    // PE 头校验:文件损坏时给出明确指引,不浪费重试
    let mut head = [0u8; 2];
    fs::File::open(&exe_plain)
        .and_then(|mut f| f.read_exact(&mut head))
        .map_err(|e| format!("安装包无法读取: {e}"))?;
    if &head != b"MZ" {
        return Err("安装包已损坏(非可执行文件),已放弃启动,请重新下载".into());
    }

    // 轻量文件日志:启动器是自动更新的最后一环,失败必须留痕可诊断
    let log = |msg: &str| {
        if let Some(dir) = exe_plain.parent().and_then(std::path::Path::parent) {
            if let Ok(mut f) = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("logs").join("installer.log"))
            {
                use std::io::Write;
                let _ = writeln!(f, "{} {}", chrono_now(), msg);
            }
        }
    };
    // 本地时间戳(避免引入 chrono,仅用于日志排序)
    fn chrono_now() -> String {
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("[unix {t}s]")
    }

    let mut last_err = String::new();

    // 尝试 1:直接启动;尝试 2:等待 400ms 重试(缓解 AV 实时扫描窗口);
    // 尝试 3:cmd start 兜底(ShellExecute 语义,走不同的加载路径)
    for attempt in 1..=3 {
        let res = if attempt <= 2 {
            if attempt == 2 {
                std::thread::sleep(Duration::from_millis(400));
            }
            Command::new(&exe_plain)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map(|_| "ok".to_string())
        } else {
            Command::new("cmd")
                .args(["/C", "start", ""])
                .arg(&exe_plain)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map(|_| "ok".to_string())
        };
        match res {
            Ok(_) => {
                log(&format!("launch attempt {attempt} OK: {}", exe_plain.display()));
                // 给安装器进程留出初始化时间，再退出当前应用（sidecar 由 watchdog 跟随退出）
                std::thread::sleep(Duration::from_millis(300));
                app.exit(0);
                return Ok(());
            }
            Err(e) => {
                log(&format!("launch attempt {attempt} FAIL (os error {}): {e}", e.raw_os_error().unwrap_or(0)));
                last_err = e.to_string();
            }
        }
    }
    Err(format!("启动安装器失败: {last_err}"))
}

// ---------- 原生文件操作 ----------

#[derive(Serialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<FileNode>, String> {
    eprintln!("[list_dir] invoke path={path}");
    let mut nodes = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().map_err(|e| e.to_string())?.is_dir();
        nodes.push(FileNode {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
        });
    }
    // 目录在前，各自按名称排序
    nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    eprintln!("[list_dir] ok {} entries", nodes.len());
    Ok(nodes)
}

#[tauri::command]
pub fn read_file(path: String, encoding: Option<String>) -> Result<serde_json::Value, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let label = encoding.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let (text, enc_label) = match label {
        // 指定编码：按用户选择解码（BOM 移除，内容不含 BOM 字符）
        Some(want) => {
            let (enc, _) = resolve_encoding(want).ok_or_else(|| format!("不支持的编码: {want}"))?;
            let (t, _) = enc.decode_with_bom_removal(&bytes);
            (t.into_owned(), want.to_string())
        }
        // 自动检测：BOM 优先，其次 chardetng 统计检测（GBK/Big5/Shift_JIS/EUC-KR/Windows-125x 等）
        None => {
            if let Some((bom_enc, _)) = encoding_rs::Encoding::for_bom(&bytes) {
                let (t, _, _) = bom_enc.decode(&bytes);
                (t.into_owned(), bom_label(bom_enc))
            } else {
                let mut det = chardetng::EncodingDetector::new();
                det.feed(&bytes, true);
                let enc = det.guess(None, true);
                let (t, _, _) = enc.decode(&bytes);
                (t.into_owned(), enc.name().to_ascii_lowercase())
            }
        }
    };
    Ok(json!({
        "content": text,
        "language": detect_language(&path),
        "encoding": enc_label
    }))
}

#[tauri::command]
pub fn save_file(path: String, content: String, encoding: Option<String>) -> Result<(), String> {
    let label = encoding.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let bytes = match label {
        None => content.into_bytes(),
        Some(want) => encode_with(want, &content).ok_or_else(|| format!("不支持的编码: {want}"))?,
    };
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

// ---------- 文件编码辅助 ----------

/// GUI 编码标签 → encoding_rs 编码；返回 (编码, 是否写 BOM)
/// 标签约定：utf-8 / utf-8-bom / utf-16le-bom / utf-16be-bom，其余原样走 WHATWG label
fn resolve_encoding(label: &str) -> Option<(&'static encoding_rs::Encoding, bool)> {
    match label.to_ascii_lowercase().as_str() {
        "utf-8" | "utf8" => Some((encoding_rs::UTF_8, false)),
        "utf-8-bom" => Some((encoding_rs::UTF_8, true)),
        "utf-16le-bom" | "utf-16le" => Some((encoding_rs::UTF_16LE, true)),
        "utf-16be-bom" | "utf-16be" => Some((encoding_rs::UTF_16BE, true)),
        other => encoding_rs::Encoding::for_label(other.as_bytes()).map(|e| (e, false)),
    }
}

/// 编码并序列化为字节；UTF-16 恒写 BOM（与 Windows 记事本/VS Code 一致），无法映射的字符按编码规则替换
fn encode_with(label: &str, content: &str) -> Option<Vec<u8>> {
    let (enc, bom) = resolve_encoding(label)?;
    let mut out = Vec::new();
    if bom {
        // UTF-8 用 EF BB BF；UTF-16 用对应端序 BOM（与记事本/VS Code 一致）
        out.extend_from_slice(if enc == encoding_rs::UTF_16LE {
            &[0xFF, 0xFE][..]
        } else if enc == encoding_rs::UTF_16BE {
            &[0xFE, 0xFF][..]
        } else {
            &[0xEF, 0xBB, 0xBF][..]
        });
    }
    if enc == encoding_rs::UTF_8 {
        out.extend_from_slice(content.as_bytes());
    } else if enc == encoding_rs::UTF_16LE {
        out.extend(content.encode_utf16().flat_map(|u| u.to_le_bytes()));
    } else if enc == encoding_rs::UTF_16BE {
        out.extend(content.encode_utf16().flat_map(|u| u.to_be_bytes()));
    } else {
        let (bytes, _, _) = enc.encode(content);
        out.extend_from_slice(&bytes);
    }
    Some(out)
}

/// BOM 检测命中的编码 → GUI 标签（UTF-16 恒带 BOM；UTF-8 区分带/不带）
fn bom_label(enc: &'static encoding_rs::Encoding) -> String {
    if enc == encoding_rs::UTF_8 {
        "utf-8-bom".into()
    } else if enc == encoding_rs::UTF_16LE {
        "utf-16le-bom".into()
    } else if enc == encoding_rs::UTF_16BE {
        "utf-16be-bom".into()
    } else {
        enc.name().to_ascii_lowercase()
    }
}

#[cfg(test)]
mod encoding_tests {
    use super::{bom_label, encode_with, resolve_encoding};
    use encoding_rs::Encoding;

    fn enc_of(label: &str) -> &'static Encoding {
        resolve_encoding(label).unwrap().0
    }

    #[test]
    fn gbk_roundtrip() {
        let text = "你好，世界 // hello";
        let bytes = encode_with("gbk", text).unwrap();
        // GBK 双字节：0xC4 0xE3 = 你
        assert_eq!(&bytes[..2], &[0xC4, 0xE3]);
        let (decoded, _, _) = enc_of("gbk").decode(&bytes);
        assert_eq!(decoded, text);
    }

    #[test]
    fn gb18030_roundtrip() {
        let text = "代码优化智能体 Code ✓";
        let bytes = encode_with("gb18030", text).unwrap();
        let (decoded, _, _) = enc_of("gb18030").decode(&bytes);
        assert_eq!(decoded, text);
    }

    #[test]
    fn utf8_bom_roundtrip() {
        let bytes = encode_with("utf-8-bom", "fn main() {}").unwrap();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF]);
        let (decoded, _) = enc_of("utf-8").decode_with_bom_removal(&bytes);
        assert_eq!(decoded, "fn main() {}");
    }

    #[test]
    fn utf16le_bom_roundtrip() {
        let text = "hello 世界";
        let bytes = encode_with("utf-16le-bom", text).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xFE]);
        let (decoded, _) = enc_of("utf-16le").decode_with_bom_removal(&bytes);
        assert_eq!(decoded, text);
    }

    #[test]
    fn utf16be_bom_roundtrip() {
        let bytes = encode_with("utf-16be-bom", "abc").unwrap();
        assert_eq!(&bytes[..2], &[0xFE, 0xFF]);
        let (decoded, _) = enc_of("utf-16be").decode_with_bom_removal(&bytes);
        assert_eq!(decoded, "abc");
    }

    #[test]
    fn big5_shiftjis_euckr_roundtrip() {
        for (label, text) in [
            ("big5", "中文測試"),
            ("shift_jis", "コード最適化"),
            ("euc-kr", "코드 최적화"),
        ] {
            let bytes = encode_with(label, text).unwrap();
            let (decoded, _, _) = enc_of(label).decode(&bytes);
            assert_eq!(decoded, text, "roundtrip fail: {label}");
        }
    }

    #[test]
    fn latin1_unmappable_replaced_not_panic() {
        // Windows-1252 无法表示 ✓ → 按编码规则替换，不 panic
        let bytes = encode_with("windows-1252", "café ✓").unwrap();
        assert!(!bytes.is_empty());
    }

    #[test]
    fn unsupported_label_rejected() {
        assert!(resolve_encoding("not-a-real-enc").is_none());
        assert!(encode_with("not-a-real-enc", "x").is_none());
    }

    #[test]
    fn bom_label_mapping() {
        assert_eq!(bom_label(encoding_rs::UTF_8), "utf-8-bom");
        assert_eq!(bom_label(encoding_rs::UTF_16LE), "utf-16le-bom");
        assert_eq!(bom_label(encoding_rs::GBK), "gbk");
    }

    #[test]
    fn chardetng_detects_gbk_without_bom() {
        // GBK 编码的中文长文本（无 BOM）→ chardetng 应识别为 GBK
        let text = "这是一个用于验证编码自动检测的中文字符串，包含足够的样本长度让统计检测器收敛判定。";
        let (bytes, _, _) = enc_of("gbk").encode(text);
        let mut det = chardetng::EncodingDetector::new();
        det.feed(&bytes, true);
        let enc = det.guess(None, true);
        assert_eq!(enc.name(), "GBK");
    }

    #[test]
    fn read_save_command_gbk_roundtrip() {
        use super::{read_file, save_file};
        let p = std::env::temp_dir().join(format!("mrsliy-enc-gbk-{}.tmp", std::process::id()));
        let text = "这是命令级端到端往返测试的中文字符串，长度足够让自动检测收敛为 GBK 编码判定。";
        std::fs::write(&p, encode_with("gbk", text).unwrap()).unwrap();
        // 自动检测读取
        let r = read_file(p.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!(r["encoding"].as_str(), Some("gbk"));
        assert_eq!(r["content"].as_str(), Some(text));
        // 以相同编码保存修改后的内容 → 再读回验证
        let updated = "更新后的内容 // updated";
        save_file(p.to_string_lossy().into_owned(), updated.into(), Some("gbk".into())).unwrap();
        let r2 = read_file(p.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!(r2["content"].as_str(), Some(updated));
        assert_eq!(r2["encoding"].as_str(), Some("gbk"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn read_command_detects_utf8_bom() {
        use super::read_file;
        let p = std::env::temp_dir().join(format!("mrsliy-enc-bom-{}.tmp", std::process::id()));
        std::fs::write(&p, encode_with("utf-8-bom", "plain ascii + 中文").unwrap()).unwrap();
        let r = read_file(p.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!(r["encoding"].as_str(), Some("utf-8-bom"));
        assert_eq!(r["content"].as_str(), Some("plain ascii + 中文"));
        let _ = std::fs::remove_file(&p);
    }
}

/// 前端状态文件路径：~/.mr-sliy/gui-state/<name>.json
/// localStorage 在 WebView2 中异步落盘，进程被强杀（看门狗/崩溃）时会丢数据，
/// 工作区与会话状态改用文件持久化。
#[tauri::command]
pub fn state_file_path(name: String) -> Result<String, String> {
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid state name".into());
    }
    let home = std::env::var("USERPROFILE").map_err(|_| "no USERPROFILE".to_string())?;
    let dir = std::path::Path::new(&home).join(".mr-sliy").join("gui-state");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{name}.json")).to_string_lossy().to_string())
}

fn detect_language(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "js" | "mjs" | "cjs" => "javascript",
        "ts" | "tsx" => "typescript",
        "py" => "python",
        "java" => "java",
        "go" => "go",
        "rs" => "rust",
        "json" => "json",
        _ => "plaintext",
    }
}

// ---------- 转发到 sidecar 的业务 API ----------

#[tauri::command]
pub fn analyze_file(
    state: State<SidecarState>,
    filePath: String,
    sourceCode: String,
) -> Result<serde_json::Value, String> {
    post_json(
        state.port(),
        "/api/scan/file",
        json!({ "filePath": filePath, "sourceCode": sourceCode }),
    )
}

#[tauri::command]
pub fn optimize_issue(
    state: State<SidecarState>,
    code: String,
    filePath: Option<String>,
    language: Option<String>,
    issueType: Option<String>,
    message: Option<String>,
) -> Result<serde_json::Value, String> {
    post_json(
        state.port(),
        "/api/ai/optimize",
        json!({
            "code": code,
            "filePath": filePath,
            "language": language,
            "issueType": issueType,
            "message": message
        }),
    )
}

#[tauri::command]
pub fn issue_stats(state: State<SidecarState>) -> Result<serde_json::Value, String> {
    get_json(state.port(), "/api/issues/stats")
}
