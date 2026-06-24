; Inno Setup script for the Mnemosyne native helper (Stage 5.4, alpha 0.0.2).
;
; Per-user install (no admin): drops the helper + bundled yt-dlp/ffmpeg, then registers
; the native-messaging host so the browser can launch it on demand. Uninstall fully
; cleans up: unregisters the host and removes runtime data.
;
; ASCII-only custom strings on purpose; the wizard UI itself is localized via the
; bundled Russian/English language files below.

#define AppName "Mnemosyne Helper"
#define AppVersion "0.0.2-alpha"
#define AppPublisher "Mnemosyne"
#define HelperExe "mnemosyne-helper.exe"

[Setup]
; Stable AppId so upgrades replace the same install (do not change once shipped).
AppId={{67D81278-8146-465F-A5F8-963C48377F30}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\Mnemosyne
DefaultGroupName=Mnemosyne
DisableProgramGroupPage=yes
; Per-user install -> no administrator rights, no UAC, fewer SmartScreen hurdles.
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=mnemosyne-helper-setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Files]
; The helper and its bundled third-party tools all land in {app}; tools.go resolves
; them next to the executable.
Source: "..\helper\bin\mnemosyne-helper.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\helper\tools\yt-dlp.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\helper\tools\ffmpeg.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\helper\tools\ffprobe.exe"; DestDir: "{app}"; Flags: ignoreversion

[Run]
; Register the native-messaging host (writes manifest + HKCU registry for Chrome/Edge),
; pointing at the just-installed exe.
Filename: "{app}\{#HelperExe}"; Parameters: "register"; Flags: runhidden waituntilterminated; StatusMsg: "Registering native messaging host..."

[UninstallRun]
; Stop any running helper first (it may hold the exe open), then full cleanup
; (unregister + remove runtime data) before files are deleted.
Filename: "{cmd}"; Parameters: "/c taskkill /f /im {#HelperExe} /t"; Flags: runhidden; RunOnceId: "KillHelper"
Filename: "{app}\{#HelperExe}"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "UninstallHelper"

[Code]
// Before installing (e.g. upgrade/reinstall), stop a running helper so its exe is not
// locked while we overwrite it.
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssInstall then
    Exec(ExpandConstant('{cmd}'), '/c taskkill /f /im {#HelperExe} /t',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;
