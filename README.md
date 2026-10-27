# Swiftload

A fast, open-source download manager for **macOS** and **Windows**.

Swiftload splits each download into several parallel connections, resumes interrupted downloads,
sorts files into folders by type, and comes with a browser extension that catches downloads and
grabs videos from web pages.

- **Segmented downloads**: up to 32 connections per file. Idle connections take over the largest remaining chunk.
- **Pause and resume**, even after quitting the app or restarting the computer (when the server supports it).
- **Automatic categories**: Video, Music, Documents, Compressed, Programs, General.
- **Queue**: choose how many downloads run at the same time.
- **Scheduler**: only download between two times of day (e.g. overnight).
- **Speed limit** for all downloads together.
- **Browser extension** (Chrome, Edge, Brave): sends browser downloads to the app.
- **Video grabber**: a "Download video" button on web videos. Supports MP4/WebM files and HLS streams (`.m3u8`).
- **YouTube, Facebook, Instagram, TikTok**: choose Best / 1080p / 720p / 480p / MP3, powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp).

---

## Contents

- [Install on macOS](#install-on-macos)
- [Install on Windows](#install-on-windows)
- [Optional dependencies](#optional-dependencies)
- [Install the browser extension](#install-the-browser-extension)
- [How to use](#how-to-use)
- [Build from source](#build-from-source)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Limitations](#limitations)
- [Legal](#legal)
- [License](#license)

---

## Install on macOS

**Requirements:** macOS 12 or newer, Apple Silicon (M1 or later).
For Intel Macs, [build from source](#build-from-source).

1. Download `Swiftload-<version>-arm64.dmg` from the [Releases](../../releases) page.
2. Open the DMG and drag **Swiftload** into **Applications**.
3. The app isn't signed with an Apple developer certificate, so macOS blocks the first launch. To open it:
   - Right-click **Swiftload** in Applications, choose **Open**, then **Open** again. Or:
   - Run this once in Terminal:
     ```sh
     xattr -dr com.apple.quarantine /Applications/Swiftload.app
     ```
4. Optional: allow notifications to get a message when a download finishes.

Closing the window keeps downloads running in the background. Click the Dock icon or the menu-bar icon to bring
the window back. Quit with **⌘Q** or **Quit Swiftload** in the menu-bar icon.

## Install on Windows

**Requirements:** Windows 10 or 11, 64-bit.

1. Download `Swiftload-Setup-<version>-x64.exe` from the [Releases](../../releases) page.
2. Run it. The installer isn't code-signed, so Windows SmartScreen may show
   **"Windows protected your PC"**. Click **More info → Run anyway**.
3. Pick an install folder and finish the setup. Swiftload appears in the Start menu.

Closing the window keeps downloads running in the background. Click the Swiftload icon in the notification area
(system tray, bottom-right; it may be under the **^** arrow) to bring the window back. Right-click it and choose
**Quit Swiftload** to quit. Unfinished downloads resume next time you start it.

---

## Optional dependencies

Swiftload works on its own for normal downloads. Two free tools unlock extra features:

| Tool | What it enables |
|------|-----------------|
| [ffmpeg](https://ffmpeg.org) | Converts HLS streams (`.ts`) to `.mp4`, merges separate video and audio tracks, and is needed for YouTube/Facebook/Instagram/TikTok downloads and MP3 extraction |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) + [Deno](https://deno.com) | YouTube, Facebook, Instagram and TikTok downloads. yt-dlp needs a JavaScript runtime such as Deno for YouTube |

### macOS

Install with [Homebrew](https://brew.sh):

```sh
brew install ffmpeg yt-dlp
```

Homebrew's `yt-dlp` installs Deno automatically. Swiftload looks for the tools in `/opt/homebrew/bin`
and `/usr/local/bin`.

### Windows

Install with `winget` (built into Windows 10/11) from **Command Prompt** or **PowerShell**:

```powershell
winget install Gyan.FFmpeg yt-dlp.yt-dlp DenoLand.Deno
```

Swiftload finds the tools through your `PATH`. **Restart Swiftload** after installing them.
Check that they're found:

```powershell
ffmpeg -version
yt-dlp --version
```

### Keep yt-dlp up to date

Video sites change often, and an old yt-dlp is the most common reason a YouTube download fails.

- macOS: `brew upgrade yt-dlp`
- Windows: `winget upgrade yt-dlp.yt-dlp`

---

## Install the browser extension

The extension works in **Google Chrome, Microsoft Edge, Brave** and other Chromium-based browsers.
Firefox and Safari are not supported yet.

1. Download the `extension` folder from this repository: either clone the repo or use **Code → Download ZIP** and unzip it.
2. Open the extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
3. Turn on **Developer mode** (top-right in Chrome; left sidebar in Edge).
4. Click **Load unpacked** and select the `extension` folder.
5. **Swiftload Catcher** now appears in your extension list.

Keep the `extension` folder where it is: the browser loads it from that location.
After updating the folder, click the reload icon on the extension card.

**What the extension does:**
- **Catches downloads.** When you download a file in the browser, it goes to Swiftload instead.
  If Swiftload isn't running, the browser downloads it normally.
- **Download video button.** Hover over a video on a web page and click **⬇ Download video**:
  - On YouTube, Facebook, Instagram and TikTok, choose a quality (Best, 1080p, 720p, 480p, MP3).
  - On other sites, play the video for a few seconds first, then choose from the list of media the page loaded.

**Permissions it asks for, and why:**

| Permission | Why |
|---|---|
| Downloads | Catch new downloads and hand them to the app |
| Cookies | Pass your login cookies for the file's site, so downloads that need you to be signed in still work |
| Web requests | Detect video/audio files and streams the page loads |
| Storage | Remember the detected media per tab |
| Access to all sites | Show the video button and detect media on any page |

The extension only talks to the Swiftload app on your own computer (`127.0.0.1`) and never sends data anywhere else.

---

## How to use

### Add a download

- Click **＋ Add URL**, paste a link and click **Start download**. Optionally:
  - **Save as**: choose a file name.
  - **Quality**: used only for YouTube, Facebook, Instagram and TikTok links.
- Or just download something in your browser with the extension installed.

### Manage downloads

| Action | How |
|---|---|
| Open a finished file | Click its blue name, double-click the row, or press **Enter** |
| Show the file in Finder / Explorer | Right-click → **Show in Finder** / **Show in Explorer**, or click **📂 Folder** |
| Pause / Resume | **❚❚ Pause** / **▶ Resume**, or press **Space**. Double-click a paused or failed download to resume it |
| Remove | **✕ Remove** or **Delete**. Choose **Remove from List** or **Move to Trash** (Recycle Bin on Windows) |
| Copy the link or file path | Right-click → **Copy Link** / **Copy File Path** |
| Download again | Right-click → **Download Again** (keeps the old file; the new one gets a new name) |
| Select several | **⌘/Ctrl-click** to add, **Shift-click** for a range, **⌘/Ctrl+A** for all. Actions apply to all selected |
| Search | Type in the search box (**⌘/Ctrl+F**). **Esc** clears it |
| Sort | Click the **Name**, **Size** or **Added** column header; click again to reverse |
| Filter | Use the sidebar: All, Unfinished, Finished, or a category |
| Everything at once | Sidebar: **Pause all**, **Resume all**, **Clear finished** (clears the list only, files stay) |

**Keyboard shortcuts**

| Key | Action |
|---|---|
| ⌘/Ctrl+N | Add URL |
| ⌘/Ctrl+F | Search |
| Enter | Open the selected finished file |
| Space | Pause or resume the selection |
| Delete / Backspace | Remove the selection |
| ↑ / ↓ | Move the selection |
| ⌘/Ctrl+A | Select all |
| Esc | Clear the selection or search |

### Copied links

When you copy a download link (for example a `.zip`, `.mp4` or `.dmg` URL, or a YouTube video page), Swiftload
shows a notification. Click it to open the Add dialog with the link filled in. **＋ Add URL** also fills
in a copied link automatically. Turn this off in **⚙ Settings → Offer to download links I copy**.

### Menu-bar / tray icon

Swiftload adds an icon to the macOS menu bar or the Windows notification area (system tray), with
**Show Swiftload**, **Add URL…**, **Pause All**, **Resume All**, **Open Download Folder** and **Quit**.
While downloads run, the Dock / taskbar icon shows overall progress (and on macOS, the number of active downloads).

### Where files are saved

By default into your **Downloads** folder, in a subfolder per category:

| Category | File types (examples) |
|---|---|
| Video | mp4, mkv, webm, mov, avi, ts |
| Music | mp3, m4a, aac, flac, wav, ogg |
| Documents | pdf, doc(x), xls(x), ppt(x), txt, epub |
| Compressed | zip, rar, 7z, tar, gz |
| Programs | dmg, pkg, exe, msi, apk, iso |
| General | everything else |

Change the base folder in **⚙ Settings → Download folder**.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| Download folder | `Downloads` | Base folder; category subfolders are created inside it |
| Connections per download | 8 | Parallel connections per file. Some servers limit this; lower it if downloads stall |
| Simultaneous downloads | 3 | How many downloads run at once; the rest wait in the queue |
| Speed limit | 0 (unlimited) | Total speed in KB/s across all downloads |
| Scheduler | Off | Only download between the two times. Running downloads pause at the end time and continue at the start time |
| Offer to download links I copy | On | Show a notification when you copy a download link |

---

## Build from source

### Prerequisites

- [Node.js](https://nodejs.org) 22 or newer (includes npm)
- [Git](https://git-scm.com)
- macOS or Windows (Linux works for development but has no packaged build yet)

### Run in development

```sh
git clone https://github.com/didarulamin/swiftload.git
cd swiftload/app
npm install
npm start
```

`npm install` downloads Electron. If npm says install scripts are blocked, approve Electron's:

```sh
npm install-scripts approve electron
```

> **Running from the VS Code terminal?** VS Code sets `ELECTRON_RUN_AS_NODE`, which stops Electron from
> opening a window. Start the app with:
> - macOS / Linux: `env -u ELECTRON_RUN_AS_NODE npm start`
> - Windows (PowerShell): `Remove-Item Env:ELECTRON_RUN_AS_NODE; npm start`

### Run the tests

```sh
npm test
```

The tests start local test servers. The ffmpeg-based tests run only if ffmpeg is installed.

### Build installers

| Command | Output (in `app/dist/`) | Build on |
|---|---|---|
| `npm run dist` | `Swiftload-<version>-arm64.dmg` (macOS, Apple Silicon) | macOS |
| `npm run dist:win` | `Swiftload Setup <version>.exe` (Windows x64 installer) | macOS or Windows |

For an Intel Mac build, run `npx electron-builder --mac dmg --x64`.

### Project structure

```
app/                     Electron desktop app
  main.js                Window, tray, right-click menu, clipboard watcher, local bridge for the extension
  preload.js             Safe API between the window and the app
  engine/
    download.js          Segmented HTTP(S) downloader with resume and speed limiting
    hls.js               HLS (.m3u8) stream downloader (+ .ts → .mp4 via ffmpeg)
    merge.js             Downloads separate video + audio tracks and merges them
    ytdlp.js             YouTube / Facebook / Instagram / TikTok via yt-dlp
    queue.js             Download list, queue, scheduler, categories, saving state
  renderer/              The window UI (HTML/CSS/JS, no framework)
  assets/                Menu-bar / tray icons
  test/                  Tests (node:test, no extra dependencies)
extension/               Chromium extension (Manifest V3)
```

Only two development dependencies: `electron` and `electron-builder`.

---

## Troubleshooting

**The extension doesn't send downloads to the app**
- Make sure Swiftload is running.
- The app listens on `127.0.0.1:47321`. If another program uses that port, the extension can't reach the app.
- Reload the extension in `chrome://extensions` after updating it.

**"Needs yt-dlp" or "needs ffmpeg" error**
- Install them as described in [Optional dependencies](#optional-dependencies), then restart Swiftload.
- On Windows, check that `yt-dlp --version` and `ffmpeg -version` work in a new terminal.

**A YouTube download fails**
- Update yt-dlp first (see [Keep yt-dlp up to date](#keep-yt-dlp-up-to-date)).
- Age-restricted, private and members-only videos need a signed-in account and are not supported yet.

**A download is stuck or very slow**
- Some servers allow only a few connections. Lower **Connections per download** in Settings.
- Check that the **Scheduler** is off, or that you're inside its time window.
- Check the **Speed limit** setting.

**"File changed on server, restart the download"**
- The file on the server changed since the download started, so the parts can't be combined.
  Delete the download and add it again.

**Where is my download list stored?**
- macOS: `~/Library/Application Support/swiftload/downloads.json`
- Windows: `%APPDATA%\swiftload\downloads.json`

Deleting this file clears the list; it doesn't delete downloaded files.

---

## How it works

1. **Probe**: the first connection requests the file and checks whether the server supports partial downloads (HTTP `Range`).
2. **Split**: if it does, more connections start. Each new connection takes the second half of the largest
   remaining part, so fast connections keep getting work until the file is complete.
3. **Write**: every connection writes straight into its position in one pre-allocated `.part` file.
4. **Resume**: progress is saved every second. On resume, each part continues where it stopped, and `If-Range`
   makes sure the file hasn't changed on the server.
5. **Finish**: the `.part` file is renamed. If a file with that name exists, ` (1)` is added.

Servers without `Range` support fall back to a single connection; those downloads restart from the beginning if interrupted.

**Extension ↔ app:** the extension sends a JSON `POST` to `http://127.0.0.1:47321/add`. The app accepts
only requests that come from a browser extension. Ordinary web pages can't make it start downloads.

---

## Limitations

- Encrypted or DRM-protected streams (e.g. Netflix, Disney+, Spotify) are not supported, and won't be.
- Live streams are not supported.
- DASH streams (`.mpd`) on other sites are not supported (except through yt-dlp on the supported sites).
- Firefox and Safari extensions are not available yet.
- No FTP support.
- Installers are not code-signed, so you'll see a warning the first time you open the app.

---

## Contributing

Issues and pull requests are welcome.

1. Fork the repo and create a branch.
2. Make your change; keep it small and focused.
3. Run `npm test` in `app/` and make sure everything passes.
4. Open a pull request describing what changed and why.

---

## Legal

- Only download content you own or have permission to download. Respect each website's terms of service
  and copyright law in your country.
- YouTube, Facebook, Instagram and TikTok support relies on [yt-dlp](https://github.com/yt-dlp/yt-dlp),
  a separate open-source project that you install yourself. Swiftload does not include it.
- Swiftload is an independent project. It is not affiliated with or endorsed by any other download manager,
  website or video platform mentioned here. All trademarks belong to their owners.

## License

Released under the [MIT License](LICENSE).
