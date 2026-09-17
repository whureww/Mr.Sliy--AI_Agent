; Inno Setup 7 打包脚本 · MR·SLIY 代码优化智能体桌面端
; 编译: "C:\Program Files\Inno Setup 7\ISCC.exe" d:\Final\final\installer\mrsliy.iss

#define MyAppName "MR·SLIY 代码优化智能体"
#define MyAppExeName "mrsliy-desktop.exe"
#define MyAppVersion "0.2.0"
#define ProjRoot "d:\Final\final"

[Setup]
AppId={{7D9E4F21-6C3A-4B8E-9A12-3F5D8B0C2E47}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher=MR·SLIY
DefaultDirName={autopf}\MRSLIY
DefaultGroupName=MR·SLIY
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
OutputDir={#ProjRoot}\installer
OutputBaseFilename=MRSLIY-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
SetupIconFile={#ProjRoot}\src-tauri\icons\icon.ico
; 勾选 CLI 任务时写入系统 PATH，安装完成后广播环境变更
ChangesEnvironment=yes

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"
Name: "cli"; Description: "安装命令行工具（CLI，可在任意终端运行 mr-sliy）"; GroupDescription: "附加任务:"; Flags: checkedonce

[Files]
; 主程序（release 构建产物，前端资源已嵌入）
Source: "{#ProjRoot}\src-tauri\target\release\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
; 内置 Node 运行时（安装版不依赖系统 node）
Source: "{#ProjRoot}\installer\staging\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
; sidecar 与 Node 后端
Source: "{#ProjRoot}\sidecar.js"; DestDir: "{app}"; Flags: ignoreversion
; MCP 服务器独立入口（stdio 模式，供 Claude Desktop / Cursor 等客户端接入）
Source: "{#ProjRoot}\mcp-server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjRoot}\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjRoot}\.env.example"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "{#ProjRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "{#ProjRoot}\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#ProjRoot}\database\*"; DestDir: "{app}\database"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist; Excludes: "*.db,*.db-shm,*.db-wal"
Source: "{#ProjRoot}\scripts\*"; DestDir: "{app}\scripts"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "node_modules,node_modules\*,package.json,package-lock.json"
; 生产依赖（含 tree-sitter wasm 与原生模块，与内置 node ABI 匹配）
Source: "{#ProjRoot}\node_modules\*"; DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; 图标直接取 exe 内嵌资源(exe 已打包 icon.ico);此前引用 {app}\mrsliy.ico
; 但该文件从未随 [Files] 安装,导致快捷方式显示未知图标
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "立即运行 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "taskkill"; Parameters: "/f /im {#MyAppExeName}"; RunOnceId: "KillApp"; Flags: runhidden

[Code]
// 安装/卸载前结束主程序；sidecar 携带父进程 watchdog，主程序退出后 3 秒内自动退出
procedure Sleep(ms: Integer); external 'Sleep@kernel32.dll stdcall';

const
  EnvPathKey = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment';
  MslHwndBroadcast = $FFFF;
  MslWmSettingChange = $001A;
  MslSmtoAbortIfHung = $0002;

// 安装完成后通知资源管理器重载环境变量（否则新开终端拿不到更新后的 PATH）
function SendMessageTimeoutW(hWnd: LongWord; Msg: LongWord; wParam: LongWord;
  lParam: string; fuFlags: LongWord; uTimeout: LongWord; var lpdwResult: LongWord): LongWord;
  external 'SendMessageTimeoutW@user32.dll stdcall';

procedure BroadcastEnvironmentChange();
var
  Res: LongWord;
begin
  SendMessageTimeoutW(MslHwndBroadcast, MslWmSettingChange, 0, 'Environment', MslSmtoAbortIfHung, 2000, Res);
end;

// 生成 CLI 垫片：用内置 Node 运行 CLI 入口，不依赖系统 node
// 同时提供 mr-sliy 与 sliy 两个命令名（与 npm 全局安装的 bin 别名一致）
procedure WriteCliShim();
var
  AppDir, Content: String;
begin
  AppDir := ExpandConstant('{app}');
  Content := '@echo off' #13#10
    + 'setlocal' #13#10
    + '"' + AppDir + '\runtime\node.exe" "' + AppDir + '\src\agent.js" %*' #13#10;
  SaveStringToFile(ExpandConstant('{app}\mr-sliy.cmd'), Content, False);
  SaveStringToFile(ExpandConstant('{app}\sliy.cmd'), Content, False);
end;

function PathContains(const Path, Dir: String): Boolean;
begin
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Path) + ';') > 0;
end;

procedure AddToPath();
var
  Path, AppDir: String;
begin
  AppDir := ExpandConstant('{app}');
  if not RegQueryStringValue(HKEY_LOCAL_MACHINE, EnvPathKey, 'Path', Path) then
    Path := '';
  if PathContains(Path, AppDir) then Exit;
  if Path = '' then Path := AppDir else Path := Path + ';' + AppDir;
  RegWriteStringValue(HKEY_LOCAL_MACHINE, EnvPathKey, 'Path', Path);
end;

procedure RemoveFromPath();
var
  Path, Rest, AppDir, Up, Part, NewPath: String;
  P: Integer;
begin
  if not RegQueryStringValue(HKEY_LOCAL_MACHINE, EnvPathKey, 'Path', Path) then Exit;
  AppDir := ExpandConstant('{app}');
  Up := Uppercase(AppDir);
  NewPath := '';
  Rest := Path;
  while Length(Rest) > 0 do begin
    P := Pos(';', Rest);
    if P = 0 then begin
      Part := Rest;
      Rest := '';
    end else begin
      Part := Copy(Rest, 1, P - 1);
      Rest := Copy(Rest, P + 1, MaxInt);
    end;
    if Uppercase(Trim(Part)) <> Up then begin
      if NewPath = '' then NewPath := Part else NewPath := NewPath + ';' + Part;
    end;
  end;
  RegWriteStringValue(HKEY_LOCAL_MACHINE, EnvPathKey, 'Path', NewPath);
end;

procedure KillRunningApp();
var
  ResultCode: Integer;
begin
  Exec('taskkill', '/f /im {#MyAppExeName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  // 等待 sidecar watchdog 退出，避免覆盖 runtime\node.exe 时撞文件锁
  Sleep(3500);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    KillRunningApp();
  if CurStep = ssPostInstall then begin
    if WizardIsTaskSelected('cli') then begin
      WriteCliShim();
      AddToPath();
      BroadcastEnvironmentChange();
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then begin
    KillRunningApp();
    RemoveFromPath();
    BroadcastEnvironmentChange();
  end;
end;
