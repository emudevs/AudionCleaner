from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

try:
    from tkinterdnd2 import DND_FILES, TkinterDnD
    RootBase = TkinterDnD.Tk
    DND_AVAILABLE = True
except Exception:
    RootBase = tk.Tk
    DND_AVAILABLE = False

from common import (
    APP_ROOT,
    APP_VERSION,
    DEFAULT_SETTINGS,
    POST_PROFILES,
    load_runtime,
    load_settings,
    save_settings,
)
from processor import (
    AUDIO_EXTS,
    VIDEO_EXTS,
    AudioStream,
    Cancelled,
    inspect_media,
    process_one,
)


PRESET_INFO = {
    "instrumental_full": "Макс. сохранение исходного звука. Лучший старт для аниме/кино.",
    "instrumental_balanced": "Баланс сохранения эффектов и удаления голоса.",
    "instrumental_clean": "Самое агрессивное удаление голосов, выше риск артефактов.",
    "instrumental_low_resource": "Быстрее и легче по VRAM, качество ниже.",
    "karaoke": "Удаление ведущего вокала. Для диалогов обычно хуже.",
    "vocal_balanced": "Vocal-oriented ensemble; Instrumental берётся как второй stem.",
    "vocal_clean": "Vocal-oriented, минимальный bleed в вокале.",
    "vocal_full": "Vocal-oriented, максимум захвата вокала.",
    "vocal_rvc": "Оптимизировано для RVC/voice-training.",
}

# Neutral editing-panel palette, shared by ttk and native Tk widgets.
COLORS = {
    "bg": "#1e1e1e", "panel": "#262626", "field": "#141414",
    "border": "#303030", "text": "#c5c5c5", "muted": "#909090",
    "accent": "#2997ff", "button": "#383838",
}


class SettingsPanel(ttk.Frame):
    """Notebook page with a scrollable body for smaller editing workspaces."""

    def __init__(self, parent):
        super().__init__(parent)
        self.canvas = tk.Canvas(self, bg=COLORS["bg"], highlightthickness=0)
        bar = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=bar.set)
        bar.pack(side="right", fill="y")
        self.canvas.pack(side="left", fill="both", expand=True)
        self.body = ttk.Frame(self.canvas)
        self.window = self.canvas.create_window(0, 0, window=self.body, anchor="nw")
        self.body.bind("<Configure>", self._resize_content)
        self.canvas.bind("<Configure>", self._resize_canvas)
        self.bind("<Map>", lambda _e: self._bind_wheel(self.body))

    def _resize_content(self, _event):
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))

    def _resize_canvas(self, event):
        self.canvas.itemconfigure(self.window, width=event.width)

    def _bind_wheel(self, widget):
        widget.bind("<MouseWheel>", self._wheel)
        for child in widget.winfo_children():
            self._bind_wheel(child)
        self.canvas.bind("<MouseWheel>", self._wheel)

    def _wheel(self, event):
        if self.body.winfo_height() > self.canvas.winfo_height():
            self.canvas.yview_scroll(-int(event.delta / 120), "units")
        return "break"


class TrackDialog(tk.Toplevel):
    def __init__(self, parent, streams: list[AudioStream]):
        super().__init__(parent)
        self.configure(bg=COLORS["bg"])
        self.title("Выбор аудиодорожки")
        self.geometry("760x390")
        self.minsize(620, 320)
        self.transient(parent)
        self.grab_set()
        self.result = None
        self.streams = streams

        ttk.Label(
            self,
            text="В видео несколько аудиодорожек. Выбери нужную:",
            font=("Segoe UI", 12, "bold"),
        ).pack(anchor="w", padx=18, pady=(18, 10))

        columns = ("index", "lang", "title", "codec", "channels", "rate")
        tree = ttk.Treeview(self, columns=columns, show="headings", height=10)
        tree.heading("index", text="#")
        tree.heading("lang", text="Язык")
        tree.heading("title", text="Название")
        tree.heading("codec", text="Кодек")
        tree.heading("channels", text="Каналы")
        tree.heading("rate", text="Hz")

        tree.column("index", width=45, anchor="center")
        tree.column("lang", width=70)
        tree.column("title", width=280)
        tree.column("codec", width=90)
        tree.column("channels", width=70, anchor="center")
        tree.column("rate", width=80, anchor="center")
        tree.pack(fill="both", expand=True, padx=18, pady=3)

        for i, s in enumerate(streams):
            tree.insert(
                "",
                "end",
                iid=str(i),
                values=(
                    s.index,
                    s.language or "—",
                    s.title or "—",
                    s.codec,
                    s.channels or "—",
                    s.sample_rate or "—",
                ),
            )
        tree.selection_set("0")
        tree.focus("0")

        buttons = ttk.Frame(self)
        buttons.pack(fill="x", padx=18, pady=14)

        ttk.Button(buttons, text="Отмена", command=self.destroy).pack(side="right", padx=(8, 0))
        ttk.Button(
            buttons,
            text="Использовать дорожку",
            command=lambda: self.accept(tree),
        ).pack(side="right")

        tree.bind("<Double-1>", lambda _e: self.accept(tree))
        self.protocol("WM_DELETE_WINDOW", self.destroy)

    def accept(self, tree):
        selection = tree.selection()
        if not selection:
            return
        self.result = self.streams[int(selection[0])]
        self.destroy()


class App(RootBase):
    def __init__(self):
        super().__init__()
        self.title(f"Anime Audio Cleaner {APP_VERSION}")
        self.geometry("1180x780")
        self.minsize(1000, 640)

        self.settings = load_settings()
        self.source_path: Path | None = None
        self.stream: AudioStream | None = None
        self.is_video = False
        self.processing = False
        self.cancel_event = threading.Event()
        self.events = queue.Queue()

        self._configure_style()
        self._build_ui()
        self._load_settings_to_vars()
        self.after(100, self._pump_events)
        self.after(0, self._dark_titlebar)

    def _dark_titlebar(self):
        if os.name != "nt":
            return
        try:
            import ctypes
            from ctypes import wintypes
            get_parent = ctypes.windll.user32.GetParent
            get_parent.argtypes = [wintypes.HWND]
            get_parent.restype = wintypes.HWND
            set_attribute = ctypes.windll.dwmapi.DwmSetWindowAttribute
            set_attribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
            enabled = ctypes.c_int(1)
            hwnd = get_parent(self.winfo_id())
            set_attribute(hwnd, 20, ctypes.byref(enabled), ctypes.sizeof(enabled))
            caption = wintypes.DWORD(0x001e1e1e)
            set_attribute(hwnd, 35, ctypes.byref(caption), ctypes.sizeof(caption))
        except (AttributeError, OSError):
            pass

    def _configure_style(self):
        c = COLORS
        self.configure(bg=c["bg"])
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except Exception:
            pass

        style.configure(".", font=("Segoe UI", 9), background=c["bg"],
                        foreground=c["text"], bordercolor=c["border"],
                        lightcolor=c["border"], darkcolor=c["border"], focuscolor=c["accent"])
        style.configure("TFrame", background=c["bg"])
        style.configure("Card.TFrame", background=c["panel"])
        style.configure("TLabel", background=c["bg"], foreground=c["text"])
        style.configure("Card.TLabel", background=c["panel"])
        style.configure("Title.TLabel", font=("Segoe UI Semibold", 17), foreground="#f3f3f3")
        style.configure("Muted.TLabel", foreground=c["muted"])
        style.configure("Eyebrow.TLabel", foreground=c["accent"], font=("Segoe UI Semibold", 9))
        style.configure("Badge.TLabel", background=c["panel"], foreground=c["accent"], padding=(10, 6))
        style.configure("TButton", background=c["button"], padding=(10, 4), borderwidth=1, relief="flat")
        style.map("TButton", background=[("disabled", "#292929"), ("pressed", "#484848"), ("active", "#454545")],
                  foreground=[("disabled", "#737373")], bordercolor=[("focus", c["accent"])])
        style.configure("Accent.TButton", background=c["accent"], foreground="#101820", font=("Segoe UI Semibold", 10))
        style.map("Accent.TButton", background=[("disabled", "#303d4a"), ("pressed", "#519ce9"), ("active", "#99caff")],
                  foreground=[("disabled", "#8897a6"), ("!disabled", "#101820")])
        for name in ("TEntry", "TCombobox"):
            style.configure(name, fieldbackground=c["field"], background=c["button"],
                            foreground=c["text"], insertcolor=c["text"], padding=3, arrowsize=12)
            style.map(name, fieldbackground=[("readonly", c["field"]), ("disabled", c["panel"])],
                      foreground=[("disabled", "#737373"), ("readonly", c["text"])],
                      bordercolor=[("focus", c["accent"])], selectbackground=[("!disabled", "#345b80")],
                      selectforeground=[("!disabled", "#ffffff")])
        self.option_add("*TCombobox*Listbox.background", c["field"])
        self.option_add("*TCombobox*Listbox.foreground", c["text"])
        self.option_add("*TCombobox*Listbox.selectBackground", "#345b80")
        self.option_add("*TCombobox*Listbox.selectForeground", "#ffffff")
        self.option_add("*TCombobox*Listbox.font", "{Segoe UI} 10")
        style.configure("TCheckbutton", padding=(0, 0), indicatorbackground=c["field"], indicatormargin=6)
        style.map("TCheckbutton", background=[("active", c["bg"])],
                  indicatorbackground=[("selected", c["accent"]), ("!selected", c["field"])],
                  foreground=[("disabled", "#737373")])
        style.configure("TNotebook", background=c["bg"], borderwidth=0, tabmargins=(0, 0, 0, 0))
        style.configure("TNotebook.Tab", background=c["bg"], padding=(18, 10), borderwidth=0)
        style.map("TNotebook.Tab", background=[("selected", c["panel"]), ("active", "#303030")],
                  foreground=[("selected", c["accent"]), ("!selected", c["muted"])])
        style.configure("TLabelframe", background=c["bg"], borderwidth=1, relief="solid")
        style.configure("TLabelframe.Label", background=c["bg"], foreground=c["muted"], font=("Segoe UI Semibold", 10))
        style.configure("Horizontal.TProgressbar", background=c["accent"], troughcolor=c["field"],
                        borderwidth=0, thickness=4)
        style.configure("Vertical.TScrollbar", background=c["button"], troughcolor=c["bg"],
                        borderwidth=0, arrowsize=12)
        style.map("Vertical.TScrollbar", background=[("active", "#555555")])
        style.configure("Treeview", background=c["field"], fieldbackground=c["field"], rowheight=32, borderwidth=0)
        style.configure("Treeview.Heading", background=c["panel"], foreground=c["muted"], padding=8, relief="flat")
        style.map("Treeview", background=[("selected", "#345b80")], foreground=[("selected", "#ffffff")])
        style.map("Treeview.Heading", background=[("active", c["button"])])

        style.layout("TNotebook.Tab", [("Notebook.tab", {"sticky": "nswe", "children": [
            ("Notebook.padding", {"side": "top", "sticky": "nswe", "children": [
                ("Notebook.label", {"side": "top", "sticky": ""})]})]})])
        style.configure("TNotebook.Tab", padding=(12, 7), bordercolor=c["bg"],
                        lightcolor=c["bg"], darkcolor=c["bg"])
        style.configure("TNotebook", bordercolor=c["bg"], lightcolor=c["bg"], darkcolor=c["bg"])
        style.layout("Panel.TNotebook.Tab", [])
        style.configure("Value.TEntry", foreground=c["accent"], fieldbackground=c["bg"],
                        borderwidth=0, bordercolor=c["bg"], lightcolor=c["bg"], darkcolor=c["bg"])
        style.map("Value.TEntry", bordercolor=[("focus", c["accent"])])
        style.layout("Horizontal.TProgressbar", [("Horizontal.Progressbar.trough", {"sticky": "nswe", "children": [
            ("Horizontal.Progressbar.pbar", {"side": "left", "sticky": "ns"})]})])

    @staticmethod
    def _panel_title(parent, text, active=False):
        title = tk.Frame(parent, bg=COLORS["bg"], height=31)
        title.pack(fill="x")
        title.pack_propagate(False)
        tk.Label(title, text=text, bg=COLORS["bg"], fg=COLORS["text"],
                 font=("Segoe UI", 9), anchor="w").pack(side="left", padx=10)
        tk.Label(title, text="≡", bg=COLORS["bg"], fg=COLORS["muted"]).pack(side="right", padx=10)
        tk.Frame(parent, height=1, bg=COLORS["accent"] if active else COLORS["border"]).pack(fill="x")

    def _section(self, parent, text):
        shell = ttk.Frame(parent)
        shell.pack(fill="x", pady=(0, 7))
        body = ttk.Frame(shell)
        opened = tk.BooleanVar(value=True)
        def toggle():
            opened.set(not opened.get())
            header.configure(text=("▾   " if opened.get() else "▸   ") + text)
            if opened.get():
                body.pack(fill="x")
            else:
                body.pack_forget()
        header = tk.Button(shell, text="▾   " + text, anchor="w", command=toggle,
                           bg=COLORS["panel"], fg=COLORS["text"], activebackground="#303030",
                           activeforeground=COLORS["text"], relief="flat", bd=0,
                           font=("Segoe UI Semibold", 9), padx=8, pady=4,
                           highlightthickness=0, cursor="hand2")
        header.pack(fill="x")
        body.pack(fill="x")
        if parent is self.output_panel.body:
            body.columnconfigure(0, weight=1)
        else:
            body.columnconfigure(0, minsize=270)
            body.columnconfigure(1, weight=1)
        return body

    def _build_ui(self):
        # Fixed footer is reserved first so it can never be clipped by the workspace.
        footer = ttk.Frame(self, padding=(10, 7))
        footer.pack(side="bottom", fill="x")
        self.cancel_btn = ttk.Button(footer, text="Отмена", command=self.cancel, state="disabled")
        self.cancel_btn.pack(side="right")
        self.start_btn = ttk.Button(footer, text="Обработать", style="Accent.TButton",
                                    command=self.start_processing, state="disabled")
        self.start_btn.pack(side="right", padx=8)
        self.status_label = ttk.Label(footer, text="Готово к работе", style="Muted.TLabel", width=36)
        self.status_label.pack(side="left")
        self.progress = ttk.Progressbar(footer, maximum=100)
        self.progress.pack(side="left", fill="x", expand=True, padx=16)

        toolbar = ttk.Frame(self, padding=(12, 6))
        toolbar.pack(fill="x")
        ttk.Label(toolbar, text="Audio Cleaner", font=("Segoe UI Semibold", 10)).pack(side="left", padx=(0, 28))
        ttk.Label(toolbar, text="ОБРАБОТКА АУДИО", style="Eyebrow.TLabel").pack(side="left")
        self.device_label = ttk.Label(toolbar, text=self._device_text(), style="Muted.TLabel")
        self.device_label.pack(side="right")

        workspace = tk.PanedWindow(self, orient="vertical", bg="#101010", sashwidth=5, bd=0)
        workspace.pack(fill="both", expand=True)
        upper = tk.PanedWindow(workspace, orient="horizontal", bg="#101010", sashwidth=5, bd=0)
        workspace.add(upper, minsize=330, stretch="always")
        effects = ttk.Frame(upper)
        properties = ttk.Frame(upper, width=310)
        upper.add(effects, minsize=640, stretch="always")
        upper.add(properties, minsize=290, width=310, stretch="never")
        self._panel_title(effects, "Элементы управления эффектами", active=True)
        self._panel_title(properties, "Свойства • Результат")

        source = ttk.Frame(effects, padding=(10, 8))
        source.pack(fill="x")
        self.drop = source
        ttk.Button(source, text="＋  Импорт…", command=self.choose_file).pack(side="right", padx=(12, 0))
        self.file_label = ttk.Label(source, text="Источник: клип не выбран")
        self.file_label.pack(anchor="w", fill="x")
        self.stream_label = ttk.Label(source, text="Перетащите видео или аудио в эту панель", style="Muted.TLabel")
        self.stream_label.pack(anchor="w", pady=(3, 0))
        source.bind("<Configure>", lambda e: self.file_label.configure(wraplength=max(200, e.width-150)))
        if DND_AVAILABLE:
            for widget in (source, *source.winfo_children()):
                widget.drop_target_register(DND_FILES)
                widget.dnd_bind("<<Drop>>", self._on_drop)

        tabs = ttk.Frame(effects)
        tabs.pack(fill="x", padx=8)
        self.notebook = ttk.Notebook(effects, style="Panel.TNotebook")
        self.notebook.pack(fill="both", expand=True, padx=8, pady=(0, 8))
        self.tab_main = SettingsPanel(self.notebook)
        self.tab_post = SettingsPanel(self.notebook)
        self.tab_advanced = SettingsPanel(self.notebook)
        self.notebook.add(self.tab_main, text="Разделение голоса")
        self.notebook.add(self.tab_post, text="Постобработка")
        self.notebook.add(self.tab_advanced, text="Система")
        self.tab_buttons = []
        for page, label in [(self.tab_main, "Разделение голоса"), (self.tab_post, "Постобработка"), (self.tab_advanced, "Система")]:
            item = tk.Frame(tabs, bg=COLORS["bg"])
            item.pack(side="left", padx=(0, 14))
            button = tk.Button(item, text=label, command=lambda p=page: self.notebook.select(p),
                               bg=COLORS["bg"], fg=COLORS["muted"], activebackground=COLORS["bg"],
                               activeforeground=COLORS["text"], bd=0, relief="flat", padx=3, pady=7,
                               highlightthickness=0, font=("Segoe UI", 9))
            button.pack()
            line = tk.Frame(item, height=2, bg=COLORS["bg"])
            line.pack(fill="x")
            self.tab_buttons.append((page, button, line))
        def update_tabs(_event=None):
            for page, button, line in self.tab_buttons:
                selected = str(page) == self.notebook.select()
                button.configure(fg=COLORS["text"] if selected else COLORS["muted"])
                line.configure(bg=COLORS["accent"] if selected else COLORS["bg"])
        self.notebook.bind("<<NotebookTabChanged>>", update_tabs)
        update_tabs()

        self.output_panel = SettingsPanel(properties)
        self.output_panel.pack(fill="both", expand=True, padx=8, pady=4)
        self._build_main_tab()
        self._build_post_tab()
        self._build_advanced_tab()
        self._build_output_panel()

        self.tab_log = ttk.Frame(workspace)
        workspace.add(self.tab_log, minsize=90, height=145, stretch="never")
        self._panel_title(self.tab_log, "Журнал обработки")
        self._build_log_tab()
        self._log("Ожидание источника. Импортируйте видео или аудио для начала обработки.")

    def _build_output_panel(self):
        f = self.output_panel.body
        destination = self._section(f, "Файл результата")
        ttk.Label(destination, text="Путь сохранения", style="Muted.TLabel").pack(anchor="w", padx=8, pady=(8, 4))
        self.output_var = tk.StringVar()
        ttk.Entry(destination, textvariable=self.output_var).pack(fill="x", padx=8)
        ttk.Button(destination, text="Обзор…", command=self.choose_output).pack(anchor="e", padx=8, pady=3)
        out = self._section(f, "Формат аудио")
        self.output_sr_var = tk.IntVar()
        self.output_depth_var = tk.StringVar()
        self._entry_row(out, 0, "Частота, Hz", self.output_sr_var)
        ttk.Label(out, text="Разрядность").grid(row=1, column=0, sticky="w", padx=10, pady=4)
        ttk.Combobox(out, textvariable=self.output_depth_var, values=["16-bit PCM", "24-bit PCM", "32-bit float"],
                     state="readonly", width=14).grid(row=1, column=1, sticky="w", padx=8, pady=4)
        ttk.Label(out, text="Контейнер").grid(row=2, column=0, sticky="w", padx=10, pady=3)
        ttk.Label(out, text="WAV / Stereo", style="Eyebrow.TLabel").grid(row=2, column=1, sticky="w", padx=8)
        options = self._section(f, "Обработка")
        self.auto_start_var = tk.BooleanVar()
        self.keep_prepared_var = tk.BooleanVar()
        self.keep_raw_var = tk.BooleanVar()
        for text, variable in [("Автостарт после импорта", self.auto_start_var),
                               ("Сохранить Prepared WAV", self.keep_prepared_var),
                               ("Сохранить Raw после AI", self.keep_raw_var)]:
            ttk.Checkbutton(options, text=text, variable=variable).pack(anchor="w", padx=8, pady=3)
        ttk.Label(f, text="Результат: имя_файла_Clear.wav", style="Muted.TLabel").pack(anchor="w", padx=8, pady=4)

    def _build_main_tab(self):
        f = self.tab_main.body

        preset_box = self._section(f, "AI • Разделение голоса")

        ttk.Label(preset_box, text="Режим:").grid(row=0, column=0, sticky="w", padx=10, pady=4)
        self.preset_var = tk.StringVar()
        preset = ttk.Combobox(
            preset_box,
            textvariable=self.preset_var,
            values=list(PRESET_INFO.keys()),
            state="readonly",
            width=34,
        )
        preset.grid(row=0, column=1, sticky="w", padx=8, pady=4)
        preset.bind("<<ComboboxSelected>>", lambda _e: self._update_preset_info())

        self.preset_info = ttk.Label(preset_box, text="", wraplength=560, style="Muted.TLabel")
        self.preset_info.grid(row=1, column=0, columnspan=3, sticky="w", padx=10, pady=(0, 10))

        ttk.Label(preset_box, text="Точность:").grid(row=2, column=0, sticky="w", padx=10, pady=4)
        self.precision_var = tk.StringVar()
        ttk.Combobox(
            preset_box,
            textvariable=self.precision_var,
            values=["fp32", "autocast", "native_fp16"],
            state="readonly",
            width=20,
        ).grid(row=2, column=1, sticky="w", padx=8, pady=4)

        self.torch_compile_var = tk.BooleanVar()
        ttk.Checkbutton(
            preset_box,
            text="Torch compile — ускорение повторных запусков",
            variable=self.torch_compile_var,
        ).grid(row=3, column=0, columnspan=3, sticky="w", padx=10, pady=4)

    def _build_post_tab(self):
        f = self.tab_post.body

        profile = self._section(f, "Профиль")

        self.post_profile_var = tk.StringVar()
        ttk.Label(profile, text="Профиль:").grid(row=0, column=0, padx=10, pady=8, sticky="w")
        cb = ttk.Combobox(
            profile,
            textvariable=self.post_profile_var,
            values=["off", "safe", "restoration", "custom"],
            state="readonly",
            width=22,
        )
        cb.grid(row=0, column=1, padx=8, pady=8, sticky="w")
        cb.bind("<<ComboboxSelected>>", self._apply_post_profile)

        left = self._section(f, "Очистка")
        right = self._section(f, "Громкость / динамика")

        self.highpass_enabled_var = tk.BooleanVar()
        self.highpass_hz_var = tk.DoubleVar()
        ttk.Checkbutton(left, text="High-pass", variable=self.highpass_enabled_var).grid(row=0, column=0, sticky="w", padx=10, pady=3)
        self._entry_row(left, 1, "Частота HPF, Hz", self.highpass_hz_var)

        self.denoise_mode_var = tk.StringVar()
        ttk.Label(left, text="Denoise").grid(row=2, column=0, sticky="w", padx=10, pady=3)
        ttk.Combobox(
            left,
            textvariable=self.denoise_mode_var,
            values=["off", "auto", "always"],
            state="readonly",
            width=14,
        ).grid(row=2, column=1, sticky="w", padx=8, pady=3)

        self.denoise_reduction_var = tk.DoubleVar()
        self.noise_floor_var = tk.DoubleVar()
        self.noise_flatness_var = tk.DoubleVar()
        self._entry_row(left, 3, "Подавление, dB", self.denoise_reduction_var)
        self._entry_row(left, 4, "Порог noise floor, dBFS", self.noise_floor_var)
        self._entry_row(left, 5, "Порог flatness (0–1)", self.noise_flatness_var)

        self.declick_var = tk.BooleanVar()
        ttk.Checkbutton(left, text="De-click (опционально)", variable=self.declick_var).grid(row=6, column=0, columnspan=2, sticky="w", padx=10, pady=3)

        self.high_end_recovery_var = tk.BooleanVar()
        ttk.Checkbutton(
            left,
            text="Подмешать ВЧ оригинала\n(может вернуть сибилянты)",
            variable=self.high_end_recovery_var,
        ).grid(row=7, column=0, columnspan=2, sticky="w", padx=10, pady=3)

        self.high_end_cutoff_var = tk.DoubleVar()
        self.high_end_gain_var = tk.DoubleVar()
        self._entry_row(left, 8, "ВЧ cutoff, Hz", self.high_end_cutoff_var)
        self._entry_row(left, 9, "ВЧ gain, dB", self.high_end_gain_var)

        self.loudnorm_var = tk.BooleanVar()
        ttk.Checkbutton(right, text="EBU R128 loudness normalization", variable=self.loudnorm_var).grid(row=0, column=0, columnspan=2, sticky="w", padx=10, pady=3)

        self.target_lufs_var = tk.DoubleVar()
        self.target_lra_var = tk.DoubleVar()
        self.true_peak_var = tk.DoubleVar()
        self._entry_row(right, 1, "Target LUFS", self.target_lufs_var)
        self._entry_row(right, 2, "Target LRA", self.target_lra_var)
        self._entry_row(right, 3, "True Peak, dBTP", self.true_peak_var)

        self.compressor_var = tk.BooleanVar()
        ttk.Checkbutton(right, text="Компрессор", variable=self.compressor_var).grid(row=4, column=0, columnspan=2, sticky="w", padx=10, pady=3)

        self.comp_threshold_var = tk.DoubleVar()
        self.comp_ratio_var = tk.DoubleVar()
        self.comp_attack_var = tk.DoubleVar()
        self.comp_release_var = tk.DoubleVar()
        self._entry_row(right, 5, "Threshold, dB", self.comp_threshold_var)
        self._entry_row(right, 6, "Ratio", self.comp_ratio_var)
        self._entry_row(right, 7, "Attack, ms", self.comp_attack_var)
        self._entry_row(right, 8, "Release, ms", self.comp_release_var)

        self.limiter_var = tk.BooleanVar()
        self.limiter_limit_var = tk.DoubleVar()
        ttk.Checkbutton(right, text="Limiter (если loudnorm выключен)", variable=self.limiter_var).grid(row=9, column=0, columnspan=2, sticky="w", padx=10, pady=3)
        self._entry_row(right, 10, "Limiter limit (0–1)", self.limiter_limit_var)

    def _build_advanced_tab(self):
        f = self.tab_advanced.body

        sep = self._section(f, "audio-separator")

        self.sep_sr_var = tk.IntVar()
        self.sep_norm_var = tk.DoubleVar()
        self.sep_amp_var = tk.DoubleVar()
        self.invert_spect_var = tk.BooleanVar()
        self.use_soundfile_var = tk.BooleanVar()

        self._entry_row(sep, 0, "Внутренняя sample rate", self.sep_sr_var)
        self._entry_row(sep, 1, "Peak normalization threshold", self.sep_norm_var)
        self._entry_row(sep, 2, "Amplification threshold", self.sep_amp_var)
        ttk.Checkbutton(sep, text="Invert spectrogram для secondary stem", variable=self.invert_spect_var).grid(row=3, column=0, columnspan=2, sticky="w", padx=10, pady=3)
        ttk.Checkbutton(sep, text="Use soundfile backend", variable=self.use_soundfile_var).grid(row=4, column=0, columnspan=2, sticky="w", padx=10, pady=3)

        model = self._section(f, "Модели / система")
        self.model_dir_var = tk.StringVar()
        ttk.Entry(model, textvariable=self.model_dir_var).grid(row=0, column=0, sticky="ew", padx=10, pady=10)
        ttk.Button(model, text="Папка моделей…", command=self.choose_model_dir).grid(row=0, column=1, padx=10, pady=10)
        ttk.Button(model, text="Диагностика", command=self.show_diagnostics).grid(row=1, column=0, sticky="w", padx=10, pady=(0, 10))
        ttk.Button(model, text="Repair dependencies", command=self.repair).grid(row=1, column=1, sticky="e", padx=10, pady=(0, 10))
        model.columnconfigure(0, weight=1)

    def _build_log_tab(self):
        self.log_text = tk.Text(
            self.tab_log,
            bg=COLORS["field"],
            fg=COLORS["text"],
            insertbackground="#ffffff",
            relief="flat",
            font=("Consolas", 9),
            wrap="word",
            padx=8,
            pady=4,
            height=4,
            selectbackground="#345b80",
        )
        scrollbar = ttk.Scrollbar(self.tab_log, command=self.log_text.yview)
        scrollbar.pack(side="right", fill="y", pady=4)
        self.log_text.configure(yscrollcommand=scrollbar.set)
        self.log_text.pack(fill="both", expand=True, padx=(12, 0), pady=4)
        self.log_text.configure(state="disabled")

    @staticmethod
    def _entry_row(parent, row, label, variable):
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", padx=10, pady=3)
        ttk.Entry(parent, textvariable=variable, width=14, style="Value.TEntry").grid(row=row, column=1, sticky="w", padx=8, pady=3)

    def _device_text(self):
        runtime = load_runtime()
        env = runtime.get("environment", {})
        if env.get("cuda_available"):
            return f"CUDA · {env.get('gpu', 'NVIDIA GPU')}"
        return "CPU mode"

    def _load_settings_to_vars(self):
        s = self.settings
        self.preset_var.set(s["separator_preset"])
        self.precision_var.set(s["precision"])
        self.torch_compile_var.set(s["torch_compile"])
        self.auto_start_var.set(s["auto_start"])

        self.post_profile_var.set(s["post_profile"])
        self.highpass_enabled_var.set(s["highpass_enabled"])
        self.highpass_hz_var.set(s["highpass_hz"])
        self.denoise_mode_var.set(s["denoise_mode"])
        self.denoise_reduction_var.set(s["denoise_reduction_db"])
        self.noise_floor_var.set(s["noise_floor_threshold_db"])
        self.noise_flatness_var.set(s["noise_flatness_threshold"])
        self.declick_var.set(s["declick_enabled"])
        self.high_end_recovery_var.set(s["high_end_recovery"])
        self.high_end_cutoff_var.set(s["high_end_cutoff_hz"])
        self.high_end_gain_var.set(s["high_end_gain_db"])
        self.loudnorm_var.set(s["loudnorm_enabled"])
        self.target_lufs_var.set(s["target_lufs"])
        self.target_lra_var.set(s["target_lra"])
        self.true_peak_var.set(s["true_peak_db"])
        self.compressor_var.set(s["compressor_enabled"])
        self.comp_threshold_var.set(s["compressor_threshold_db"])
        self.comp_ratio_var.set(s["compressor_ratio"])
        self.comp_attack_var.set(s["compressor_attack_ms"])
        self.comp_release_var.set(s["compressor_release_ms"])
        self.limiter_var.set(s["limiter_enabled"])
        self.limiter_limit_var.set(s["limiter_limit"])

        self.sep_sr_var.set(s["separator_sample_rate"])
        self.sep_norm_var.set(s["separator_normalization"])
        self.sep_amp_var.set(s["separator_amplification"])
        self.invert_spect_var.set(s["separator_invert_spect"])
        self.use_soundfile_var.set(s["separator_use_soundfile"])
        self.output_sr_var.set(s["output_sample_rate"])
        self.output_depth_var.set(s["output_bit_depth"])
        self.keep_prepared_var.set(s["keep_prepared_audio"])
        self.keep_raw_var.set(s["keep_raw_separated"])
        self.model_dir_var.set(s["model_cache_dir"])
        self._update_preset_info()

    def _settings_from_vars(self):
        s = self.settings.copy()
        s.update({
            "separator_preset": self.preset_var.get(),
            "precision": self.precision_var.get(),
            "torch_compile": self.torch_compile_var.get(),
            "auto_start": self.auto_start_var.get(),

            "post_profile": self.post_profile_var.get(),
            "highpass_enabled": self.highpass_enabled_var.get(),
            "highpass_hz": self.highpass_hz_var.get(),
            "denoise_mode": self.denoise_mode_var.get(),
            "denoise_reduction_db": self.denoise_reduction_var.get(),
            "noise_floor_threshold_db": self.noise_floor_var.get(),
            "noise_flatness_threshold": self.noise_flatness_var.get(),
            "declick_enabled": self.declick_var.get(),
            "high_end_recovery": self.high_end_recovery_var.get(),
            "high_end_cutoff_hz": self.high_end_cutoff_var.get(),
            "high_end_gain_db": self.high_end_gain_var.get(),
            "loudnorm_enabled": self.loudnorm_var.get(),
            "target_lufs": self.target_lufs_var.get(),
            "target_lra": self.target_lra_var.get(),
            "true_peak_db": self.true_peak_var.get(),
            "compressor_enabled": self.compressor_var.get(),
            "compressor_threshold_db": self.comp_threshold_var.get(),
            "compressor_ratio": self.comp_ratio_var.get(),
            "compressor_attack_ms": self.comp_attack_var.get(),
            "compressor_release_ms": self.comp_release_var.get(),
            "limiter_enabled": self.limiter_var.get(),
            "limiter_limit": self.limiter_limit_var.get(),

            "separator_sample_rate": self.sep_sr_var.get(),
            "separator_normalization": self.sep_norm_var.get(),
            "separator_amplification": self.sep_amp_var.get(),
            "separator_invert_spect": self.invert_spect_var.get(),
            "separator_use_soundfile": self.use_soundfile_var.get(),
            "output_sample_rate": self.output_sr_var.get(),
            "output_bit_depth": self.output_depth_var.get(),
            "keep_prepared_audio": self.keep_prepared_var.get(),
            "keep_raw_separated": self.keep_raw_var.get(),
            "model_cache_dir": self.model_dir_var.get().strip(),
        })
        self.settings = s
        save_settings(s)
        return s

    def _apply_post_profile(self, _event=None):
        name = self.post_profile_var.get()
        if name == "custom":
            return
        profile = POST_PROFILES.get(name)
        if not profile:
            return
        self.settings.update(profile)
        self.settings["post_profile"] = name
        self._load_settings_to_vars()

    def _update_preset_info(self):
        self.preset_info.configure(text=PRESET_INFO.get(self.preset_var.get(), ""))

    def _on_drop(self, event):
        if self.processing:
            return
        paths = self.tk.splitlist(event.data)
        if paths:
            self.load_source(Path(paths[0]))

    def choose_file(self):
        initial = self.settings.get("last_dir") or str(Path.home())
        path = filedialog.askopenfilename(
            initialdir=initial,
            title="Выбери видео или аудио",
            filetypes=[
                ("Медиа", "*.mkv *.mp4 *.mov *.avi *.webm *.m4v *.ts *.m2ts *.wav *.flac *.mp3 *.m4a *.aac *.ogg *.opus"),
                ("Все файлы", "*.*"),
            ],
        )
        if path:
            self.load_source(Path(path))

    def choose_output(self):
        if not self.source_path:
            return
        path = filedialog.asksaveasfilename(
            initialdir=str(self.source_path.parent),
            initialfile=self.source_path.stem + "_Clear.wav",
            defaultextension=".wav",
            filetypes=[("WAV", "*.wav")],
        )
        if path:
            self.output_var.set(path)

    def choose_model_dir(self):
        path = filedialog.askdirectory(initialdir=self.model_dir_var.get() or str(APP_ROOT))
        if path:
            self.model_dir_var.set(path)

    def load_source(self, path: Path):
        path = path.resolve()
        if not path.exists():
            messagebox.showerror("Ошибка", "Файл не найден.")
            return

        try:
            has_video, streams = inspect_media(path)
        except Exception as exc:
            messagebox.showerror("FFprobe", str(exc))
            return

        if not streams:
            messagebox.showerror("Нет аудио", "В файле не найдено ни одной аудиодорожки.")
            return

        self.source_path = path
        self.is_video = has_video
        self.settings["last_dir"] = str(path.parent)
        self.file_label.configure(text=str(path))
        self.output_var.set(str(path.with_name(path.stem + "_Clear.wav")))

        if has_video and len(streams) > 1:
            dialog = TrackDialog(self, streams)
            self.wait_window(dialog)
            if dialog.result is None:
                self.source_path = None
                self.start_btn.configure(state="disabled")
                self.stream_label.configure(text="")
                return
            self.stream = dialog.result
        else:
            self.stream = streams[0]

        self.stream_label.configure(text=self.stream.label())
        self.start_btn.configure(state="normal")
        self._settings_from_vars()

        if self.auto_start_var.get():
            self.after(120, self.start_processing)

    def start_processing(self):
        if self.processing or not self.source_path or not self.stream:
            return

        output = Path(self.output_var.get().strip())
        if not output:
            messagebox.showerror("Результат", "Не указан путь результата.")
            return

        if output.exists():
            if not messagebox.askyesno("Файл существует", f"{output.name} уже существует. Перезаписать?"):
                return

        settings = self._settings_from_vars()

        self.processing = True
        self.cancel_event.clear()
        self.start_btn.configure(state="disabled")
        self.cancel_btn.configure(state="normal")
        self.progress["value"] = 0
        self.status_label.configure(text="Запуск…")
        self.log_text.see("end")
        self._log("=" * 72)
        self._log(f"Источник: {self.source_path}")
        self._log(f"Дорожка: {self.stream.label()}")
        self._log(f"Выход: {output}")
        self._log(f"Preset: {settings['separator_preset']} / {settings['precision']}")
        self._log("=" * 72)

        thread = threading.Thread(
            target=self._worker,
            args=(self.source_path, self.stream.index, output, settings),
            daemon=True,
        )
        thread.start()

    def _worker(self, source, stream_index, output, settings):
        try:
            result = process_one(
                source,
                stream_index,
                output,
                settings,
                log=lambda text: self.events.put(("log", text)),
                phase=lambda text, pct: self.events.put(("phase", text, pct)),
                cancel_event=self.cancel_event,
            )
            self.events.put(("done", str(result)))
        except Cancelled:
            self.events.put(("cancelled",))
        except Exception as exc:
            self.events.put(("error", repr(exc)))

    def cancel(self):
        if not self.processing:
            return
        self.cancel_event.set()
        self.status_label.configure(text="Отмена…")

    def _pump_events(self):
        try:
            while True:
                event = self.events.get_nowait()
                kind = event[0]
                if kind == "log":
                    self._log(event[1])
                elif kind == "phase":
                    self.status_label.configure(text=event[1])
                    self.progress["value"] = event[2]
                elif kind == "done":
                    self._finish()
                    self.status_label.configure(text="Готово")
                    self.progress["value"] = 100
                    self._log(f"\nГОТОВО: {event[1]}")
                    messagebox.showinfo("Готово", f"Файл сохранён:\n{event[1]}")
                elif kind == "cancelled":
                    self._finish()
                    self.status_label.configure(text="Отменено")
                    self._log("\nОперация отменена.")
                elif kind == "error":
                    self._finish()
                    self.status_label.configure(text="Ошибка")
                    self._log("\n[ОШИБКА] " + event[1])
                    messagebox.showerror("Ошибка обработки", event[1])
        except queue.Empty:
            pass
        self.after(100, self._pump_events)

    def _finish(self):
        self.processing = False
        self.cancel_btn.configure(state="disabled")
        if self.source_path:
            self.start_btn.configure(state="normal")

    def _log(self, text):
        self.log_text.configure(state="normal")
        self.log_text.insert("end", str(text) + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def show_diagnostics(self):
        runtime = load_runtime()
        messagebox.showinfo(
            "Диагностика",
            json.dumps(runtime.get("environment", {}), ensure_ascii=False, indent=2),
        )

    def repair(self):
        if self.processing:
            return
        if not messagebox.askyesno(
            "Repair",
            "Будет пересоздано виртуальное окружение и заново установлены зависимости. "
            "После этого приложение закроется. Продолжить?",
        ):
            return
        subprocess.Popen(
            [sys.executable, str(APP_ROOT / "bootstrap.py"), "--repair"],
            cwd=str(APP_ROOT),
            creationflags=subprocess.CREATE_NEW_CONSOLE if os.name == "nt" else 0,
        )
        self.destroy()


if __name__ == "__main__":
    app = App()
    app.mainloop()
