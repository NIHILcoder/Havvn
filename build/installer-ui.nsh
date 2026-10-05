; Native assisted wizard: brand artwork, localized copy and real install options.
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!define MUI_ABORTWARNING
!ifdef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.HavvnGuiInit
!else
  !define MUI_CUSTOMFUNCTION_GUIINIT HavvnGuiInit
!endif
!define MUI_WELCOMEPAGE_TITLE "$(HavvnWelcomeTitle)"
!define MUI_WELCOMEPAGE_TEXT "$(HavvnWelcomeText)"
!define MUI_FINISHPAGE_TITLE "$(HavvnFinishTitle)"
!define MUI_FINISHPAGE_TEXT "$(HavvnFinishText)"
!define MUI_FINISHPAGE_RUN_TEXT "$(HavvnLaunch)"
!define MUI_UNWELCOMEPAGE_TITLE "$(HavvnUninstallTitle)"
!define MUI_UNWELCOMEPAGE_TEXT "$(HavvnUninstallText)"

LangString HavvnWelcomeTitle 1033 "Welcome to Havvn"
LangString HavvnWelcomeTitle 1049 "Добро пожаловать в Havvn"
LangString HavvnWelcomeText 1033 "Your downloads. Your rooms. Your Havvn.$\r$\n$\r$\nDownloads under control$\r$\nTorrents, files and RSS in one place.$\r$\n$\r$\nWatch together$\r$\nRooms with synchronized playback.$\r$\n$\r$\nMake it yours$\r$\nThemes, glass and your own background.$\r$\n$\r$\nClick Next to set up Havvn."
LangString HavvnWelcomeText 1049 "Твои загрузки. Твои комнаты. Твой Havvn.$\r$\n$\r$\nЗагрузки под контролем$\r$\nТорренты, файлы и RSS в одном месте.$\r$\n$\r$\nСмотри вместе$\r$\nКомнаты с синхронным просмотром.$\r$\n$\r$\nНастрой под себя$\r$\nТемы, стекло и собственный фон.$\r$\n$\r$\nНажми «Далее», чтобы настроить Havvn."
LangString HavvnFinishTitle 1033 "Havvn is ready"
LangString HavvnFinishTitle 1049 "Havvn готов к работе"
LangString HavvnFinishText 1033 "Havvn has been installed.$\r$\n$\r$\nAdd your first download or invite friends to a room.$\r$\n$\r$\nClick Finish to close setup."
LangString HavvnFinishText 1049 "Havvn установлен.$\r$\n$\r$\nДобавь первую загрузку или пригласи друзей в комнату.$\r$\n$\r$\nНажми «Готово», чтобы закрыть установщик."
LangString HavvnLaunch 1033 "Launch Havvn"
LangString HavvnLaunch 1049 "Запустить Havvn"
LangString HavvnUninstallTitle 1033 "Uninstall Havvn"
LangString HavvnUninstallTitle 1049 "Удаление Havvn"
LangString HavvnUninstallText 1033 "Setup will remove Havvn from this computer.$\r$\n$\r$\nDownloaded files are not removed.$\r$\n$\r$\nClose Havvn before continuing."
LangString HavvnUninstallText 1049 "Мастер удалит Havvn с этого компьютера.$\r$\n$\r$\nСкачанные файлы не удаляются.$\r$\n$\r$\nЗакрой Havvn перед продолжением."
LangString HavvnOptionsTitle 1033 "Make it yours"
LangString HavvnOptionsTitle 1049 "Как тебе удобно"
LangString HavvnOptionsSubtitle 1033 "Choose shortcuts and file handlers."
LangString HavvnOptionsSubtitle 1049 "Выбери ярлыки и открытие файлов."
LangString HavvnDesktopLabel 1033 "Create a desktop shortcut"
LangString HavvnDesktopLabel 1049 "Создать ярлык на рабочем столе"
LangString HavvnMenuLabel 1033 "Add to the Start menu"
LangString HavvnMenuLabel 1049 "Добавить в меню «Пуск»"
LangString HavvnTorrentLabel 1033 "Open .torrent files with Havvn"
LangString HavvnTorrentLabel 1049 "Открывать .torrent в Havvn"
LangString HavvnMagnetLabel 1033 "Open magnet links with Havvn"
LangString HavvnMagnetLabel 1049 "Открывать magnet-ссылки в Havvn"
LangString HavvnOptionsNote 1033 "Windows may ask you to confirm Havvn as your default application."
LangString HavvnOptionsNote 1049 "Windows может попросить подтвердить Havvn как приложение по умолчанию."

!macro customHeader
  !ifdef BUILD_UNINSTALLER
    Function un.HavvnGuiInit
  !else
    Function HavvnGuiInit
  !endif
    ; Native caption matches the graphite artwork on supported Windows builds.
    ; Older systems ignore an unsupported attribute and retain their OS caption.
    Push $0
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4) i.r0'
    Pop $0
  FunctionEnd
!macroend

!ifndef BUILD_UNINSTALLER
Var HavvnDesktop
Var HavvnMenu
Var HavvnTorrent
Var HavvnMagnet
Var HavvnDesktopCheck
Var HavvnMenuCheck
Var HavvnTorrentCheck
Var HavvnMagnetCheck

!macro customInit
  ; Defaults for a fresh/silent install; updates restore the saved choices.
  StrCpy $HavvnDesktop ${BST_CHECKED}
  StrCpy $HavvnMenu ${BST_CHECKED}
  StrCpy $HavvnTorrent ${BST_CHECKED}
  StrCpy $HavvnMagnet ${BST_CHECKED}
  ClearErrors
  ReadRegDWORD $0 HKCU "Software\Havvn\Installer" "Desktop"
  ${IfNot} ${Errors}
    StrCpy $HavvnDesktop $0
  ${EndIf}
  ClearErrors
  ReadRegDWORD $0 HKCU "Software\Havvn\Installer" "Menu"
  ${IfNot} ${Errors}
    StrCpy $HavvnMenu $0
  ${EndIf}
  ClearErrors
  ReadRegDWORD $0 HKCU "Software\Havvn\Installer" "Torrent"
  ${IfNot} ${Errors}
    StrCpy $HavvnTorrent $0
  ${EndIf}
  ClearErrors
  ReadRegDWORD $0 HKCU "Software\Havvn\Installer" "Magnet"
  ${IfNot} ${Errors}
    StrCpy $HavvnMagnet $0
  ${EndIf}
  ClearErrors
!macroend

!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  Page custom HavvnOptionsShow HavvnOptionsLeave

Function HavvnOptionsShow
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(HavvnOptionsTitle)" "$(HavvnOptionsSubtitle)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 12u 100% 14u "$(HavvnDesktopLabel)"
  Pop $HavvnDesktopCheck
  ${NSD_SetState} $HavvnDesktopCheck $HavvnDesktop
  ${NSD_CreateCheckbox} 0 38u 100% 14u "$(HavvnMenuLabel)"
  Pop $HavvnMenuCheck
  ${NSD_SetState} $HavvnMenuCheck $HavvnMenu
  ${NSD_CreateCheckbox} 0 64u 100% 14u "$(HavvnTorrentLabel)"
  Pop $HavvnTorrentCheck
  ${NSD_SetState} $HavvnTorrentCheck $HavvnTorrent
  ${NSD_CreateCheckbox} 0 90u 100% 14u "$(HavvnMagnetLabel)"
  Pop $HavvnMagnetCheck
  ${NSD_SetState} $HavvnMagnetCheck $HavvnMagnet
  ${NSD_CreateLabel} 0 122u 100% 28u "$(HavvnOptionsNote)"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function HavvnOptionsLeave
  ${NSD_GetState} $HavvnDesktopCheck $HavvnDesktop
  ${NSD_GetState} $HavvnMenuCheck $HavvnMenu
  ${NSD_GetState} $HavvnTorrentCheck $HavvnTorrent
  ${NSD_GetState} $HavvnMagnetCheck $HavvnMagnet
FunctionEnd
!macroend
!endif
