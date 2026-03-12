# 勤務時間 自動入力 (Work Hours Auto-Entry)

A Chrome extension that automates the entry of self-reported clock-in and clock-out times into the **University of Tokyo Employment Management System** (東京大学 就労管理システム).

---

## Motivation & Context

Since late 2024, faculty under discretionary labor arrangements (裁量労働制) at the University of Tokyo have been required to record their work hours daily in the employment management system. This reflects institutional and regulatory requirements for employers to understand work-hour patterns and implement appropriate health measures, even under discretionary labor. The intent—to prevent overwork and ensure compliance—is clear and well understood.

In practice, however, the daily recording process has become a substantial administrative burden. Faculty are asked to register clock-in and clock-out times (or self-reported equivalents), enter rest breaks and non-work periods, and confirm the nature of work performed outside standard hours. Remote access requires VPN, so logging in from home or while traveling is often necessary. Fitting this workflow into teaching, research, and student support has proven time-consuming, and the complexity of the procedures adds to the load for both faculty and administrative staff. There is a certain irony in a system designed to reduce overwork introducing a new, ongoing administrative task that increases overall workload.

This extension was created to reduce that administrative overhead. It automates the repetitive form-filling required for self-reported clock-in and clock-out entries, so that time spent on data entry can be minimized while still maintaining accurate, compliant records.

**Important:** This tool is intended to streamline the *entry process* for hours that you have actually worked. Users should only enter times that reflect their genuine work schedule. The extension does not bypass any verification or approval steps; it simply automates the repetitive form-filling that the system requires.

---

## Features

| Feature | Description |
|--------|-------------|
| **Automatic mode** | Uses predefined time ranges (8:45–10:00 AM for clock-in, 5:00–7:00 PM for clock-out) |
| **Manual mode** | Lets you configure custom ranges for clock-in and clock-out times |
| **Weekday-only** | Automatically targets only weekdays within your selected date range |
| **Calendar-aware** | Reads your work schedule from the system’s 本人用実績入力 (personal performance entry) page to determine which days are workdays |
| **Progress tracking** | Shows real-time progress and status during the entry process |
| **Stop control** | Allows you to stop the automation at any time |

---

## Requirements

- **Google Chrome** (or a Chromium-based browser that supports Manifest V3 extensions)
- **University of Tokyo credentials** (UTokyo Account) to access the system
- **Active session** on the employment management system

The extension only works on the University of Tokyo employment management domain (`ut-ppsweb.adm.u-tokyo.ac.jp`).

---

## Installation (Developer Mode)

This extension is distributed as source code and must be loaded in Chrome’s Developer Mode. Follow these steps if you have never installed a local extension before.

### Step 1: Download the Extension

1. Go to the [GitHub repository](https://github.com/JGKarlin/ut-cws-helper).
2. Click the green **Code** button.
3. **Option A:** Click **Download ZIP** and extract the folder to a location on your computer (e.g., `Downloads` or `Documents`).
4. **Option B:** If you use Git, run `git clone <repository-url>` and navigate into the cloned folder.

---

### Step 2: Open Chrome Extensions

1. Open **Google Chrome**.
2. In the address bar, type: `chrome://extensions`
3. Press **Enter**.

---

### Step 3: Enable Developer Mode

1. Turn on **Developer mode** using the toggle in the top-right corner of the Extensions page.
2. When enabled, the toggle will be blue and show additional options.

---

### Step 4: Load the Extension

1. Click **Load unpacked** (or **Load unpacked extension**).
2. In the file picker, navigate to the folder containing the extension files.
3. Ensure you select the **root folder** of the extension (the one that contains `manifest.json`, `popup.html`, `content.js`, etc.).
4. Click **Select folder** (or **Open** on macOS).

---

### Step 5: Confirm Installation

1. The extension should appear in your extensions list.
2. Optionally, click the **Pin** icon next to the extension so it appears in Chrome’s toolbar.
3. You can now click the extension icon to open the popup.

---

### Troubleshooting

| Issue | Solution |
|-------|----------|
| **"Load unpacked" is grayed out** | Make sure Developer mode is enabled (toggle in top-right). |
| **Extension loads but shows errors** | Check that all required files are present (`manifest.json`, `content.js`, `popup.html`, `popup.js`, `background.js`, `icons/` folder). |
| **"Manifest file is missing or unreadable"** | Ensure you selected the folder that contains `manifest.json`, not a subfolder. |
| **Extension disappears after restart** | Extensions loaded in Developer mode are not permanently installed. Re-load the extension after Chrome updates or if you remove it. |

---

## Usage

### Basic Workflow

1. **Log in** to the employment management system in your browser.
2. **Open the extension** by clicking its icon in the Chrome toolbar.
3. **Configure** settings (see below).
4. **Click** 「入力開始」(Start Entry) to begin.

The extension must be used **while you are on a page** within the employment management system (e.g., the main menu or any page on `ut-ppsweb.adm.u-tokyo.ac.jp`).

---

### Configuration Options

#### 出退勤設定 (Clock-in/Clock-out Settings)

- **自動 (Automatic):** Uses default ranges for clock-in (8:45–10:00) and clock-out (17:00–19:00).
- **手動 (Manual):** Allows you to set custom time ranges for both clock-in and clock-out. Times are randomly selected within each range for each day.

#### 対象期間 (Target Period)

- **開始日 (Start Date):** First day of the range.
- **終了日 (End Date):** Last day of the range.
- **平日のみ対象:** Only weekdays are processed; weekends are excluded.

---

### Usage Screenshots

#### 1. Automatic mode (default settings)

When **自動** is selected, only the date range and target period are shown. Click **入力開始** to start.

![Automatic mode - basic settings](Screenshot%202026-03-12%20at%2011.41.23%20AM.jpg)

---

#### 2. Manual mode (custom time ranges)

When **手動** is selected, you can configure clock-in and clock-out time ranges. Times are randomly chosen within each range for each day.

![Manual mode - time range settings](Screenshot%202026-03-12%20at%2011.41.35%20AM.jpg)

---

### During operation

- The extension navigates through the system automatically.
- Progress is shown in the popup (status text and progress bar).
- You can click **停止** (Stop) at any time to halt the process.
- If a session expires or an error occurs, you may need to log in again and retry.

---

## Technical Details

- **Manifest version:** 3
- **Permissions:** `activeTab`, `scripting`, `storage`, `tabs`, and host access to `ut-ppsweb.adm.u-tokyo.ac.jp`
- **Content script:** Runs on the employment management pages to handle navigation and form filling.

---

## Disclaimer

This extension is an unofficial tool. It is not affiliated with or endorsed by the University of Tokyo. Use at your own risk. The extension is provided as-is for users who wish to reduce the administrative burden of manual time entry while maintaining accurate records of their actual work hours.

---

## Project Structure

```
├── manifest.json      # Extension manifest (Manifest V3)
├── background.js      # Service worker (storage access)
├── content.js         # Content script (runs on employment system pages)
├── popup.html         # Extension popup UI
├── popup.js           # Popup logic and automation orchestration
├── icons/             # Extension icons (16, 48, 128 px)
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md          # This file
```

---

## License

[Add your chosen license here, e.g., MIT, Apache 2.0]
