# Duplicate Cleaner v2.0

Finds identical files in a folder, shows a **preview of every copy** so you can
compare them, and deletes only the copies you pick. It runs entirely in your
browser. **Nothing is uploaded.**

---

## How to open it

1. Unzip this package anywhere, for example in `Downloads`.
2. Open the `DuplicateCleaner` folder and double-click **`index.html`**.
   You don't need to install anything or use the internet.
3. Use **Google Chrome** or **Microsoft Edge** on Windows, macOS, or ChromeOS.
   - Chrome and Edge can scan, preview, and delete.
   - Firefox and Safari can scan, preview, and save a report, but they **can't delete**.
     (Read-only mode)

> New to v2? Click **Try a sample first**. It loads a built-in demo folder,
> so you can try every feature without touching your own files.

---

## Using it

1. **Choose folder.** Pick the folder to check. The scan only reads your files.
2. **Scan options (optional).** You can include subfolders, skip hidden and
   system files, skip folders like `.git`, `node_modules`, and `$RECYCLE.BIN`,
   check only one file type, set a minimum file size, or skip folders by name.
3. **Review your copies.** Each group lists the files that are exact copies
   of each other. Each copy has a thumbnail.
   - Click a thumbnail or **Compare** to see all the copies side by side.
   - Use **Gallery** view to see groups as a grid of previews.
   - One copy in every group is marked **Keep**. You can't select it for
     deletion. Click **Keep this** on another copy to keep that one instead.
   - **Protect → Apply to all** chooses which copy to keep in every group:
     the shortest path, the cleanest name, the oldest or newest file, or the
     top-most folder.
   - **Select matching extras** selects every copy except the kept one in
     all groups, across all pages.
4. **Review deletion.** Before anything is deleted, you see the files you
   selected with their thumbnails, plus the copy that will stay in each group.
5. **Delete.** Select **I've checked the previews**, then click **Delete**.
   Chrome or Edge asks once for permission to change the folder. Choose
   **Allow** or **Save changes**.

**Warning:** Deleting is **permanent**. Deleted files **don't go to the
Recycle Bin**, so check the review screen carefully.

---

## What's new in v2: see before you delete

- **Thumbnails everywhere**: in the list, in Gallery view, in the
  selection bar, and on the deletion review screen.
- **Compare view** with two layouts:
  - **Side by side** shows every copy of a group at once.
  - **One at a time** shows a large preview with a filmstrip.
    **Actual size** lets you zoom in to check details.
- **Shows details for each copy**: full path, size, pixel dimensions for
  images, and the date it was changed.
- **Previews for many file types**:
  - Images: JPG, PNG, GIF, WebP, AVIF, BMP, ICO, and SVG
  - Videos: MP4, WebM, MOV, and MKV when Chrome supports the codec
  - Audio: MP3, WAV, M4A, OGG, and FLAC
  - PDF files
  - Text and code files: TXT, MD, CSV, JSON, LOG, and more
- **Other file types** get a file-type tile: HEIC, RAW, TIFF, PSD, Office files,
  and archives. They're still matched by their exact content.
- **Exact matching only.** Files are grouped only when their bytes are
  identical. Duplicate Cleaner checks file size first, then samples, then
  computes a full SHA-256 fingerprint. A photo that was resized or saved again
  is **not** treated as a duplicate. Duplicate Cleaner won't guess.
- **Safety checks before every deletion.** Each file is checked again right
  before it's deleted. Duplicate Cleaner skips a file and tells you why if:
  - the file is gone,
  - the file's size or date changed, or
  - the kept copy in that group is gone or changed.

  If the kept copy can't be read after a deletion, it stops right away. For
  example, this can happen if 2 paths point to the same file.
- **Changed since scan.** If files change after the scan, their group is
  marked and locked until you scan again.
- **Save report** creates a CSV file of all groups with each file's action,
  path, size, date, and fingerprint. It opens in Excel.
- **Search and sort** groups by name, folder, size, or number of copies. Long
  results are split into pages.
- **Works on small screens** and with the keyboard.

### Keyboard shortcuts (in Compare)

| Key | Action |
| --- | --- |
| `←` `→` | Previous / next copy (One at a time) |
| `K` | Keep this copy (One at a time) |
| `D` | Select or unselect this copy for deletion (One at a time) |
| `[` `]` | Previous / next group |
| `Esc` | Close |

---

## Privacy

- Files are read on your computer, inside the browser tab.
- Previews, fingerprints, and reports are made on your computer.
- Nothing is sent anywhere, and Duplicate Cleaner works offline.
- Duplicate Cleaner changes files only when you click **Delete** on the review
  screen. Even then, it deletes only the files listed there.

---

## Package contents

```
DuplicateCleaner-Complete-Package/
├─ README.md            ← this file
└─ DuplicateCleaner/
   ├─ index.html        ← open this
   ├─ styles.css
   └─ app.js
```

## About this version

Version 2.0 was rebuilt from a screenshot of the earlier version, because the
original source files weren't included. The design and steps are the same.
The visual preview and compare features are new.
