; ============================================================
;  Havvn — Custom NSIS Installer Script
;  Registers: magnet: protocol, .torrent file association
;  Background mode and autostart handled by Electron APIs.
; ============================================================

!include "installer-ui.nsh"

!macro customInstall
  DetailPrint "Registering Havvn file associations..."

  ; ── Copy icon2.ico to installation directory ────────────────
  ; electron-builder copies extra resources, but we ensure the file is present
  SetOutPath "$INSTDIR"
  File "${BUILD_RESOURCES_DIR}\icon2.ico"

  ; Builder creates its usual shortcuts first. Only remove shortcuts on a
  ; fresh install when explicitly declined; never recreate a deleted upgrade link.
  ${IfNot} ${isUpdated}
    ${If} $HavvnDesktop == ${BST_UNCHECKED}
      Delete "$newDesktopLink"
    ${EndIf}
    ${If} $HavvnMenu == ${BST_UNCHECKED}
      Delete "$newStartMenuLink"
    ${EndIf}
  ${EndIf}
  ; StartApp must not point at a shortcut that the options page just declined.
  ${IfNot} ${FileExists} "$launchLink"
    StrCpy $launchLink "$appExe"
  ${EndIf}
  WriteRegDWORD HKCU "Software\Havvn\Installer" "Desktop" $HavvnDesktop
  WriteRegDWORD HKCU "Software\Havvn\Installer" "Menu" $HavvnMenu
  WriteRegDWORD HKCU "Software\Havvn\Installer" "Torrent" $HavvnTorrent
  WriteRegDWORD HKCU "Software\Havvn\Installer" "Magnet" $HavvnMagnet

  ; ── Register magnet: protocol ──────────────────────────────
  ${If} $HavvnMagnet == ${BST_CHECKED}
  WriteRegStr HKCU "Software\Classes\magnet" "" "URL:Magnet Protocol"
  WriteRegStr HKCU "Software\Classes\magnet" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\magnet\DefaultIcon" "" "$INSTDIR\Havvn.exe,0"
  WriteRegStr HKCU "Software\Classes\magnet\shell" "" "open"
  WriteRegStr HKCU "Software\Classes\magnet\shell\open\command" "" '"$INSTDIR\Havvn.exe" "%1"'

  ; App-specific ProgID referenced by Capabilities\URLAssociations below.
  WriteRegStr HKCU "Software\Classes\Havvn.magnet" "" "URL:Havvn Magnet Protocol"
  WriteRegStr HKCU "Software\Classes\Havvn.magnet" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\Havvn.magnet\DefaultIcon" "" "$INSTDIR\Havvn.exe,0"
  WriteRegStr HKCU "Software\Classes\Havvn.magnet\shell\open\command" "" '"$INSTDIR\Havvn.exe" "%1"'
  ${EndIf}

  ; ── Register .torrent file type ────────────────────────────
  ${If} $HavvnTorrent == ${BST_CHECKED}
  WriteRegStr HKCU "Software\Classes\.torrent" "" "Havvn.file"
  WriteRegStr HKCU "Software\Classes\.torrent" "Content Type" "application/x-bittorrent"
  WriteRegStr HKCU "Software\Classes\.torrent" "PerceivedType" "document"

  ; ── Register the file type handler with CUSTOM ICON ────────
  WriteRegStr HKCU "Software\Classes\Havvn.file" "" "BitTorrent Document"

  ; Point DefaultIcon to icon2.ico (NOT the exe) so all .torrent files
  ; show the custom icon everywhere in Explorer
  WriteRegStr HKCU "Software\Classes\Havvn.file\DefaultIcon" "" "$INSTDIR\icon2.ico,0"

  WriteRegStr HKCU "Software\Classes\Havvn.file\shell" "" "open"
  WriteRegStr HKCU "Software\Classes\Havvn.file\shell\open" "" "Open with Havvn"
  WriteRegStr HKCU "Software\Classes\Havvn.file\shell\open\command" "" '"$INSTDIR\Havvn.exe" "%1"'
  ${EndIf}

  ; ── Register app as capable of handling these types ────────
  WriteRegStr HKCU "Software\Havvn\Capabilities" "ApplicationName" "Havvn"
  WriteRegStr HKCU "Software\Havvn\Capabilities" "ApplicationDescription" "Modern BitTorrent Client"
  ${If} $HavvnTorrent == ${BST_CHECKED}
    WriteRegStr HKCU "Software\Havvn\Capabilities\FileAssociations" ".torrent" "Havvn.file"
  ${EndIf}
  ${If} $HavvnMagnet == ${BST_CHECKED}
    WriteRegStr HKCU "Software\Havvn\Capabilities\URLAssociations" "magnet" "Havvn.magnet"
  ${EndIf}

  ; Register with Windows "Open With" dialog
  WriteRegStr HKCU "Software\RegisteredApplications" "Havvn" "Software\Havvn\Capabilities"

  ; ── Clean legacy TorrentHunt registrations (pre-rebrand installs) ──
  ; The same-GUID upgrade runs the OLD uninstaller which removes most of these,
  ; but be defensive: a stale ProgID would leave .torrent double-clicks pointing
  ; at a removed exe. Harmless no-ops on fresh installs.
  DeleteRegKey HKCU "Software\Classes\TorrentHunt.file"
  DeleteRegKey HKCU "Software\TorrentHunt"
  DeleteRegValue HKCU "Software\RegisteredApplications" "TorrentHunt"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "TorrentHunt"

  ; Notify Windows Shell — forces icon cache refresh immediately
  System::Call 'shell32.dll::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'

  DetailPrint "Havvn registered as torrent handler with custom icon."
!macroend

!macro customUnInstall
  DetailPrint "Removing Havvn file associations..."

  ; Another application may have become the magnet handler after installation.
  ; Only remove the shared registration if its command still points to us.
  ReadRegStr $0 HKCU "Software\Classes\magnet\shell\open\command" ""
  StrCmp $0 '"$INSTDIR\Havvn.exe" "%1"' 0 +2
    DeleteRegKey HKCU "Software\Classes\magnet"
  DeleteRegKey HKCU "Software\Classes\Havvn.magnet"

  ; Remove .torrent file association (only if we own it)
  ReadRegStr $0 HKCU "Software\Classes\.torrent" ""
  StrCmp $0 "Havvn.file" 0 +2
    DeleteRegKey HKCU "Software\Classes\.torrent"

  DeleteRegKey HKCU "Software\Classes\Havvn.file"
  DeleteRegKey HKCU "Software\Havvn"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Havvn"

  ; Remove autostart entry if present
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Havvn"

  ; Notify Windows Shell
  System::Call 'shell32.dll::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'

  DetailPrint "Havvn unregistered."
!macroend
