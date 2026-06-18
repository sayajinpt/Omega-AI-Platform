import sys
import os
import json
import threading
import queue
import time
from pathlib import Path

_pkg = Path(__file__).resolve().parent
if str(_pkg) not in sys.path:
    sys.path.insert(0, str(_pkg))

from localgen.registry import (
    IMAGE_MODEL_CATALOG,
    SPEAKERS,
    STYLE_PRESETS,
    SUPPORTED_LANGUAGES,
    TTS_MODEL_CATALOG,
)
from typing import Optional, List, Dict, Tuple
import subprocess
import tempfile
from datetime import datetime

import torch
import soundfile as sf
import numpy as np
from PIL import Image
from PIL.ImageQt import ImageQt

from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QLabel, QTextEdit, QComboBox, QGroupBox, QFormLayout,
    QProgressBar, QFileDialog, QMessageBox, QSpinBox, QCheckBox,
    QSplitter, QFrame, QLineEdit, QSlider, QTabWidget, QScrollArea,
    QGridLayout, QDoubleSpinBox, QRadioButton, QButtonGroup
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal, QTimer, QSize
from PyQt6.QtGui import QFont, QIcon, QPalette, QColor, QPixmap, QImage

import huggingface_hub
from huggingface_hub import snapshot_download, hf_hub_download, HfApi, list_repo_files
from huggingface_hub.utils import HfHubHTTPError

# Check for required packages
try:
    from qwen_tts import Qwen3TTSModel
except ImportError:
    Qwen3TTSModel = None

try:
    from diffusers import StableDiffusion3Pipeline
except ImportError:
    StableDiffusion3Pipeline = None


class ModelDownloadWorker(QThread):
    """Worker thread for downloading models with progress tracking"""
    progress = pyqtSignal(int, str)
    finished = pyqtSignal(bool, str)
    log = pyqtSignal(str)
    
    def __init__(self, model_id: str, local_dir: str, model_type: str = "tts"):
        super().__init__()
        self.model_id = model_id
        self.local_dir = local_dir
        self.model_type = model_type
        self._is_cancelled = False
        
    def cancel(self):
        self._is_cancelled = True
        
    def run(self):
        try:
            self.log.emit(f"Starting download of {self.model_id}...")
            
            # Use snapshot_download for simplicity
            snapshot_download(
                repo_id=self.model_id,
                local_dir=self.local_dir,
                local_dir_use_symlinks=False,
                resume_download=True,
                max_workers=4,
            )
            
            if self._is_cancelled:
                self.finished.emit(False, "Download cancelled by user")
                return
                
            self.progress.emit(100, "Download complete!")
            self.finished.emit(True, f"Successfully downloaded {self.model_id}")
            
        except Exception as e:
            self.finished.emit(False, f"Download failed: {str(e)}")


class TTSWorker(QThread):
    """Worker thread for TTS generation"""
    finished = pyqtSignal(bool, str, object, int)
    progress = pyqtSignal(str)
    
    def __init__(self, model, text: str, language: str, speaker: str, 
                 instruct: str, output_path: str):
        super().__init__()
        self.model = model
        self.text = text
        self.language = language
        self.speaker = speaker
        self.instruct = instruct
        self.output_path = output_path
        
    def run(self):
        try:
            self.progress.emit("Generating speech...")
            
            wavs, sr = self.model.generate_custom_voice(
                text=self.text,
                language=self.language,
                speaker=self.speaker,
                instruct=self.instruct if self.instruct else None,
            )
            
            if self.output_path:
                sf.write(self.output_path, wavs[0], sr)
                self.progress.emit(f"Saved to {self.output_path}")
            
            self.finished.emit(True, "Generation complete", wavs, sr)
            
        except Exception as e:
            self.finished.emit(False, f"Generation failed: {str(e)}", None, 0)


class ImageGenWorker(QThread):
    """Worker thread for image generation"""
    finished = pyqtSignal(bool, str, object)  # success, message, image
    progress = pyqtSignal(str, int)  # message, step
    
    def __init__(self, pipe, prompt: str, negative_prompt: str,
                 width: int, height: int, num_steps: int, 
                 guidance_scale: float, seed: int, output_path: str):
        super().__init__()
        self.pipe = pipe
        self.prompt = prompt
        self.negative_prompt = negative_prompt
        self.width = width
        self.height = height
        self.num_steps = num_steps
        self.guidance_scale = guidance_scale
        self.seed = seed
        self.output_path = output_path
        
    def run(self):
        try:
            self.progress.emit("Initializing generation...", 0)
            
            # Set seed if provided
            generator = None
            if self.seed != -1:
                generator = torch.Generator(device=self.pipe.device).manual_seed(self.seed)
            
            self.progress.emit("Generating image...", 1)
            
            # Generate image
            result = self.pipe(
                prompt=self.prompt,
                negative_prompt=self.negative_prompt if self.negative_prompt else None,
                num_inference_steps=self.num_steps,
                guidance_scale=self.guidance_scale,
                height=self.height,
                width=self.width,
                generator=generator,
            )
            
            self.progress.emit("Saving image...", self.num_steps - 1)
            
            image = result.images[0]
            
            # Save image
            if self.output_path:
                image.save(self.output_path)
            
            self.progress.emit("Complete!", self.num_steps)
            self.finished.emit(True, "Image generated successfully", image)
            
        except Exception as e:
            self.finished.emit(False, f"Generation failed: {str(e)}", None)


class MultiModalAIGUI(QMainWindow):
    """Main GUI application with TTS and Image Generation tabs"""
    
    def __init__(self):
        super().__init__()
        
        # Model instances
        self.tts_model = None
        self.image_pipe = None
        
        # Current data
        self.current_audio = None
        self.current_sr = None
        self.current_image = None
        
        # Workers
        self.download_worker = None
        self.tts_worker = None
        self.image_worker = None

        self.tts_models = TTS_MODEL_CATALOG
        self.image_models = IMAGE_MODEL_CATALOG
        self.speakers = SPEAKERS
        self.supported_languages = list(SUPPORTED_LANGUAGES)
        self.style_presets = STYLE_PRESETS

        self.init_ui()
        self.check_requirements()
        
    def init_ui(self):
        """Initialize the user interface with tabs"""
        self.setWindowTitle("AI Generation Studio - TTS & Image Generation")
        self.setMinimumSize(1400, 900)
        
        # Main widget and layout
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        main_layout = QVBoxLayout(central_widget)
        
        # Title
        title_label = QLabel("🎨 AI Generation Studio")
        title_label.setStyleSheet("font-size: 24px; font-weight: bold; padding: 10px; color: #2196F3;")
        title_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        main_layout.addWidget(title_label)
        
        # Create tab widget
        self.tab_widget = QTabWidget()
        self.tab_widget.setStyleSheet("""
            QTabWidget::pane {
                border: 1px solid #555;
                border-radius: 5px;
                background-color: #2b2b2b;
            }
            QTabBar::tab {
                background-color: #3c3c3c;
                color: #e0e0e0;
                padding: 10px 20px;
                margin-right: 2px;
                font-weight: bold;
            }
            QTabBar::tab:selected {
                background-color: #2196F3;
                color: white;
            }
            QTabBar::tab:hover:!selected {
                background-color: #4c4c4c;
            }
        """)
        
        # Create TTS Tab
        self.tts_tab = self.create_tts_tab()
        self.tab_widget.addTab(self.tts_tab, "🎤 Text-to-Speech")
        
        # Create Image Generation Tab
        self.image_tab = self.create_image_tab()
        self.tab_widget.addTab(self.image_tab, "🖼️ Text-to-Image")
        
        main_layout.addWidget(self.tab_widget)
        
        # Status bar
        self.status_bar = QLabel("Ready")
        self.status_bar.setStyleSheet("padding: 5px; background-color: #1e1e1e; color: #888;")
        main_layout.addWidget(self.status_bar)
        
        # Apply dark theme
        self.apply_dark_theme()
        
    def create_tts_tab(self):
        """Create the Text-to-Speech tab"""
        tab = QWidget()
        layout = QVBoxLayout(tab)
        
        # Split into top (settings) and bottom (generation)
        splitter = QSplitter(Qt.Orientation.Vertical)
        
        # Top section - Settings
        top_widget = QWidget()
        top_layout = QVBoxLayout(top_widget)
        
        # Model Management Group
        model_group = QGroupBox("🎤 TTS Model Management")
        model_layout = QFormLayout()
        
        # Model selection
        model_select_layout = QHBoxLayout()
        self.tts_model_combo = QComboBox()
        for model_name, model_info in self.tts_models.items():
            self.tts_model_combo.addItem(f"{model_name} [{model_info['size']}]")
        model_select_layout.addWidget(QLabel("Model:"))
        model_select_layout.addWidget(self.tts_model_combo)
        model_layout.addRow(model_select_layout)
        
        # Storage
        storage_layout = QHBoxLayout()
        self.tts_storage_path = QLineEdit(os.path.join(os.path.expanduser("~"), "qwen3_tts_models"))
        storage_browse = QPushButton("Browse")
        storage_browse.clicked.connect(lambda: self.browse_storage(self.tts_storage_path))
        storage_layout.addWidget(QLabel("Storage:"))
        storage_layout.addWidget(self.tts_storage_path)
        storage_layout.addWidget(storage_browse)
        model_layout.addRow(storage_layout)
        
        # Download/Load buttons
        button_layout = QHBoxLayout()
        self.tts_download_btn = QPushButton("📥 Download Model")
        self.tts_download_btn.clicked.connect(lambda: self.download_model("tts"))
        self.tts_download_btn.setStyleSheet("background-color: #2196F3; color: white; font-weight: bold;")
        
        self.tts_load_btn = QPushButton("📂 Load Local Model")
        self.tts_load_btn.clicked.connect(self.load_tts_model)
        self.tts_load_btn.setStyleSheet("background-color: #4CAF50; color: white; font-weight: bold;")
        
        button_layout.addWidget(self.tts_download_btn)
        button_layout.addWidget(self.tts_load_btn)
        model_layout.addRow(button_layout)
        
        # Progress
        self.tts_progress_bar = QProgressBar()
        self.tts_progress_bar.setVisible(False)
        model_layout.addRow(self.tts_progress_bar)
        
        # Status
        self.tts_status_label = QLabel("Status: No model loaded")
        self.tts_status_label.setStyleSheet("font-weight: bold; color: #FF9800;")
        model_layout.addRow(self.tts_status_label)
        
        model_group.setLayout(model_layout)
        top_layout.addWidget(model_group)
        
        # GPU Info
        gpu_group = QGroupBox("Hardware Configuration")
        gpu_layout = QVBoxLayout()
        self.tts_gpu_label = QLabel(self.get_gpu_info())
        gpu_layout.addWidget(self.tts_gpu_label)
        
        gpu_options = QHBoxLayout()
        self.tts_use_gpu = QCheckBox("Use GPU")
        self.tts_use_gpu.setChecked(torch.cuda.is_available())
        self.tts_use_gpu.setEnabled(torch.cuda.is_available())
        self.tts_use_flash = QCheckBox("FlashAttention 2")
        self.tts_use_flash.setChecked(torch.cuda.is_available())
        self.tts_use_flash.setEnabled(torch.cuda.is_available())
        gpu_options.addWidget(self.tts_use_gpu)
        gpu_options.addWidget(self.tts_use_flash)
        gpu_layout.addLayout(gpu_options)
        
        gpu_group.setLayout(gpu_layout)
        top_layout.addWidget(gpu_group)
        
        splitter.addWidget(top_widget)
        
        # Bottom section - Generation
        bottom_widget = QWidget()
        bottom_layout = QVBoxLayout(bottom_widget)
        
        # Voice & Tone Settings
        voice_group = QGroupBox("Voice & Tone Settings")
        voice_layout = QFormLayout()
        
        # Voice selection
        voice_select = QHBoxLayout()
        self.tts_voice_combo = QComboBox()
        for speaker, info in self.speakers.items():
            self.tts_voice_combo.addItem(f"{speaker} ({info['language']} - {info['gender']})")
        self.tts_voice_combo.currentIndexChanged.connect(self.update_tts_voice_info)
        voice_select.addWidget(QLabel("Voice:"))
        voice_select.addWidget(self.tts_voice_combo)
        voice_layout.addRow(voice_select)
        
        self.tts_voice_info = QLabel("")
        self.tts_voice_info.setStyleSheet("color: #888; font-style: italic;")
        voice_layout.addRow("", self.tts_voice_info)
        self.update_tts_voice_info()
        
        # Language
        lang_layout = QHBoxLayout()
        self.tts_lang_combo = QComboBox()
        self.tts_lang_combo.addItems(self.supported_languages)
        lang_layout.addWidget(QLabel("Language:"))
        lang_layout.addWidget(self.tts_lang_combo)
        voice_layout.addRow(lang_layout)
        
        # Tone/Emotion
        tone_layout = QHBoxLayout()
        self.tts_tone_input = QLineEdit()
        self.tts_tone_input.setPlaceholderText("e.g., Speak angrily, very happy, calm whisper...")
        tone_layout.addWidget(QLabel("Tone:"))
        tone_layout.addWidget(self.tts_tone_input)
        voice_layout.addRow(tone_layout)
        
        # Tone presets
        presets_layout = QHBoxLayout()
        presets = ["😊 Happy", "😢 Sad", "😠 Angry", "🤫 Whisper", "🎯 Professional", "🤗 Warm"]
        for preset in presets:
            btn = QPushButton(preset)
            btn.setMaximumWidth(100)
            btn.clicked.connect(lambda checked, p=preset: self.set_tts_tone_preset(p))
            presets_layout.addWidget(btn)
        voice_layout.addRow("Quick Tone:", None)
        voice_layout.addRow(presets_layout)
        
        # Output
        output_layout = QHBoxLayout()
        self.tts_output_path = QLineEdit("tts_output.wav")
        output_browse = QPushButton("Browse")
        output_browse.clicked.connect(lambda: self.browse_output_file(self.tts_output_path, "WAV Files (*.wav)"))
        output_layout.addWidget(QLabel("Save to:"))
        output_layout.addWidget(self.tts_output_path)
        output_layout.addWidget(output_browse)
        voice_layout.addRow(output_layout)
        
        voice_group.setLayout(voice_layout)
        bottom_layout.addWidget(voice_group)
        
        # Text Input
        text_group = QGroupBox("Text Input")
        text_layout = QVBoxLayout()
        self.tts_text_input = QTextEdit()
        self.tts_text_input.setPlaceholderText(
            "Enter text to convert to speech...\n\n"
            "Examples:\n"
            "• Chinese: 你好，今天天气真不错！\n"
            "• English: Hello, what a wonderful day!\n"
            "• Japanese: こんにちは、いい天気ですね！"
        )
        self.tts_text_input.setMaximumHeight(120)
        text_layout.addWidget(self.tts_text_input)
        text_group.setLayout(text_layout)
        bottom_layout.addWidget(text_group)
        
        # Action buttons
        action_layout = QHBoxLayout()
        
        self.tts_generate_btn = QPushButton("🎤 Generate Speech")
        self.tts_generate_btn.clicked.connect(self.generate_speech)
        self.tts_generate_btn.setMinimumHeight(50)
        self.tts_generate_btn.setStyleSheet(
            "background-color: #FF9800; color: white; font-weight: bold; font-size: 14px;"
        )
        
        self.tts_play_btn = QPushButton("▶ Play")
        self.tts_play_btn.clicked.connect(self.play_audio)
        self.tts_play_btn.setMinimumHeight(50)
        self.tts_play_btn.setEnabled(False)
        
        self.tts_stop_btn = QPushButton("⏹ Stop")
        self.tts_stop_btn.clicked.connect(self.stop_audio)
        self.tts_stop_btn.setMinimumHeight(50)
        self.tts_stop_btn.setEnabled(False)
        
        action_layout.addWidget(self.tts_generate_btn)
        action_layout.addWidget(self.tts_play_btn)
        action_layout.addWidget(self.tts_stop_btn)
        bottom_layout.addLayout(action_layout)
        
        # TTS Log
        log_group = QGroupBox("TTS Log")
        log_layout = QVBoxLayout()
        self.tts_log = QTextEdit()
        self.tts_log.setReadOnly(True)
        self.tts_log.setMaximumHeight(100)
        self.tts_log.setStyleSheet("background-color: #1e1e1e; color: #d4d4d4; font-family: monospace;")
        log_layout.addWidget(self.tts_log)
        log_group.setLayout(log_layout)
        bottom_layout.addWidget(log_group)
        
        splitter.addWidget(bottom_widget)
        splitter.setSizes([300, 500])
        
        layout.addWidget(splitter)
        return tab
        
    def create_image_tab(self):
        """Create the Text-to-Image tab"""
        tab = QWidget()
        layout = QVBoxLayout(tab)
        
        # Main horizontal splitter
        main_splitter = QSplitter(Qt.Orientation.Horizontal)
        
        # Left panel - Settings
        left_panel = QWidget()
        left_layout = QVBoxLayout(left_panel)
        
        # Model Management
        model_group = QGroupBox("🖼️ Image Model Management")
        model_layout = QFormLayout()
        
        # Model selection
        model_select = QHBoxLayout()
        self.img_model_combo = QComboBox()
        for model_name, model_info in self.image_models.items():
            self.img_model_combo.addItem(f"{model_name} [{model_info['size']}]")
        model_select.addWidget(QLabel("Model:"))
        model_select.addWidget(self.img_model_combo)
        model_layout.addRow(model_select)
        
        # Storage
        storage_layout = QHBoxLayout()
        self.img_storage_path = QLineEdit(os.path.join(os.path.expanduser("~"), "sd_models"))
        storage_browse = QPushButton("Browse")
        storage_browse.clicked.connect(lambda: self.browse_storage(self.img_storage_path))
        storage_layout.addWidget(QLabel("Storage:"))
        storage_layout.addWidget(self.img_storage_path)
        storage_layout.addWidget(storage_browse)
        model_layout.addRow(storage_layout)
        
        # Buttons
        btn_layout = QHBoxLayout()
        self.img_download_btn = QPushButton("📥 Download Model")
        self.img_download_btn.clicked.connect(lambda: self.download_model("image"))
        self.img_download_btn.setStyleSheet("background-color: #2196F3; color: white; font-weight: bold;")
        
        self.img_load_btn = QPushButton("📂 Load Model")
        self.img_load_btn.clicked.connect(self.load_image_model)
        self.img_load_btn.setStyleSheet("background-color: #4CAF50; color: white; font-weight: bold;")
        
        btn_layout.addWidget(self.img_download_btn)
        btn_layout.addWidget(self.img_load_btn)
        model_layout.addRow(btn_layout)
        
        # Progress
        self.img_progress_bar = QProgressBar()
        self.img_progress_bar.setVisible(False)
        model_layout.addRow(self.img_progress_bar)
        
        # Status
        self.img_status_label = QLabel("Status: No model loaded")
        self.img_status_label.setStyleSheet("font-weight: bold; color: #FF9800;")
        model_layout.addRow(self.img_status_label)
        
        model_group.setLayout(model_layout)
        left_layout.addWidget(model_group)
        
        # GPU Info
        gpu_group = QGroupBox("Hardware")
        gpu_layout = QVBoxLayout()
        self.img_gpu_label = QLabel(self.get_gpu_info())
        gpu_layout.addWidget(self.img_gpu_label)
        self.img_use_gpu = QCheckBox("Use GPU")
        self.img_use_gpu.setChecked(torch.cuda.is_available())
        self.img_use_gpu.setEnabled(torch.cuda.is_available())
        gpu_layout.addWidget(self.img_use_gpu)
        gpu_group.setLayout(gpu_layout)
        left_layout.addWidget(gpu_group)
        
        # Generation Settings
        gen_group = QGroupBox("Generation Settings")
        gen_layout = QFormLayout()
        
        # Width
        self.img_width = QComboBox()
        self.img_width.addItems(["512", "768", "1024", "1280"])
        self.img_width.setCurrentText("1024")
        gen_layout.addRow("Width:", self.img_width)
        
        # Height
        self.img_height = QComboBox()
        self.img_height.addItems(["512", "768", "1024", "1280"])
        self.img_height.setCurrentText("1024")
        gen_layout.addRow("Height:", self.img_height)
        
        # Steps
        self.img_steps = QSpinBox()
        self.img_steps.setRange(1, 50)
        self.img_steps.setValue(8)
        gen_layout.addRow("Steps:", self.img_steps)
        
        # Guidance Scale
        self.img_guidance = QDoubleSpinBox()
        self.img_guidance.setRange(1.0, 20.0)
        self.img_guidance.setValue(1.5)
        self.img_guidance.setSingleStep(0.1)
        gen_layout.addRow("Guidance:", self.img_guidance)
        
        # Seed
        seed_layout = QHBoxLayout()
        self.img_seed = QSpinBox()
        self.img_seed.setRange(-1, 999999999)
        self.img_seed.setValue(-1)
        self.img_seed.setSpecialValueText("Random")
        random_seed_btn = QPushButton("🎲")
        random_seed_btn.setMaximumWidth(40)
        random_seed_btn.clicked.connect(lambda: self.img_seed.setValue(np.random.randint(0, 999999999)))
        seed_layout.addWidget(self.img_seed)
        seed_layout.addWidget(random_seed_btn)
        gen_layout.addRow("Seed:", seed_layout)
        
        # Style presets
        self.img_style_combo = QComboBox()
        self.img_style_combo.addItem("None")
        self.img_style_combo.addItems(self.style_presets.keys())
        self.img_style_combo.currentTextChanged.connect(self.apply_style_preset)
        gen_layout.addRow("Style:", self.img_style_combo)
        
        # Output
        output_layout = QHBoxLayout()
        self.img_output_path = QLineEdit("generated_image.png")
        output_browse = QPushButton("Browse")
        output_browse.clicked.connect(lambda: self.browse_output_file(self.img_output_path, "Images (*.png *.jpg *.webp)"))
        output_layout.addWidget(QLabel("Save to:"))
        output_layout.addWidget(self.img_output_path)
        output_layout.addWidget(output_browse)
        gen_layout.addRow(output_layout)
        
        gen_group.setLayout(gen_layout)
        left_layout.addWidget(gen_group)
        
        # Generate button
        self.img_generate_btn = QPushButton("🎨 Generate Image")
        self.img_generate_btn.clicked.connect(self.generate_image)
        self.img_generate_btn.setMinimumHeight(50)
        self.img_generate_btn.setStyleSheet(
            "background-color: #E91E63; color: white; font-weight: bold; font-size: 14px;"
        )
        left_layout.addWidget(self.img_generate_btn)
        
        # Image log
        log_group = QGroupBox("Image Log")
        log_layout = QVBoxLayout()
        self.img_log = QTextEdit()
        self.img_log.setReadOnly(True)
        self.img_log.setMaximumHeight(80)
        self.img_log.setStyleSheet("background-color: #1e1e1e; color: #d4d4d4; font-family: monospace;")
        log_layout.addWidget(self.img_log)
        log_group.setLayout(log_layout)
        left_layout.addWidget(log_group)
        
        main_splitter.addWidget(left_panel)
        
        # Right panel - Input and Output
        right_panel = QWidget()
        right_layout = QVBoxLayout(right_panel)
        
        # Prompt input
        prompt_group = QGroupBox("Prompt")
        prompt_layout = QVBoxLayout()
        self.img_prompt = QTextEdit()
        self.img_prompt.setPlaceholderText(
            "Enter your image prompt...\n\n"
            "Example: A beautiful landscape with mountains and a lake at sunset, "
            "photorealistic, highly detailed, 8k resolution"
        )
        self.img_prompt.setMaximumHeight(100)
        prompt_layout.addWidget(self.img_prompt)
        prompt_group.setLayout(prompt_layout)
        right_layout.addWidget(prompt_group)
        
        # Negative prompt
        neg_group = QGroupBox("Negative Prompt")
        neg_layout = QVBoxLayout()
        self.img_negative_prompt = QTextEdit()
        self.img_negative_prompt.setPlaceholderText("Things to avoid... (e.g., blurry, low quality, distorted)")
        self.img_negative_prompt.setMaximumHeight(60)
        neg_layout.addWidget(self.img_negative_prompt)
        neg_group.setLayout(neg_layout)
        right_layout.addWidget(neg_group)
        
        # Image display
        display_group = QGroupBox("Generated Image")
        display_layout = QVBoxLayout()
        
        self.img_display = QLabel()
        self.img_display.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.img_display.setMinimumSize(512, 512)
        self.img_display.setStyleSheet("background-color: #1e1e1e; border: 1px solid #555;")
        self.img_display.setText("Generated image will appear here")
        display_layout.addWidget(self.img_display)
        
        # Progress bar for generation
        self.img_gen_progress = QProgressBar()
        self.img_gen_progress.setVisible(False)
        display_layout.addWidget(self.img_gen_progress)
        
        display_group.setLayout(display_layout)
        right_layout.addWidget(display_group)
        
        main_splitter.addWidget(right_panel)
        main_splitter.setSizes([400, 900])
        
        layout.addWidget(main_splitter)
        return tab
        
    def apply_dark_theme(self):
        """Apply dark theme"""
        self.setStyleSheet("""
            QMainWindow {
                background-color: #2b2b2b;
            }
            QGroupBox {
                color: #e0e0e0;
                border: 1px solid #555;
                border-radius: 5px;
                margin-top: 10px;
                padding-top: 15px;
                font-weight: bold;
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                left: 10px;
                padding: 0 5px;
            }
            QLabel {
                color: #e0e0e0;
            }
            QPushButton {
                background-color: #3c3c3c;
                color: #e0e0e0;
                border: 1px solid #555;
                padding: 5px;
                border-radius: 3px;
            }
            QPushButton:hover {
                background-color: #4c4c4c;
            }
            QPushButton:pressed {
                background-color: #2c2c2c;
            }
            QPushButton:disabled {
                background-color: #2c2c2c;
                color: #666;
            }
            QComboBox, QSpinBox, QDoubleSpinBox {
                background-color: #3c3c3c;
                color: #e0e0e0;
                border: 1px solid #555;
                padding: 3px;
                border-radius: 3px;
            }
            QTextEdit, QLineEdit {
                background-color: #1e1e1e;
                color: #d4d4d4;
                border: 1px solid #555;
                border-radius: 3px;
                padding: 5px;
            }
            QProgressBar {
                border: 1px solid #555;
                border-radius: 3px;
                text-align: center;
                color: #e0e0e0;
            }
            QProgressBar::chunk {
                background-color: #2196F3;
                border-radius: 2px;
            }
        """)
        
    def check_requirements(self):
        """Check required packages"""
        if Qwen3TTSModel is None:
            self.tts_log.append("⚠ qwen-tts not installed. Install: pip install qwen-tts")
        if StableDiffusion3Pipeline is None:
            self.img_log.append("⚠ diffusers not installed. Install: pip install diffusers")
            
    def browse_storage(self, path_widget):
        """Browse for storage directory"""
        directory = QFileDialog.getExistingDirectory(self, "Select Directory", path_widget.text())
        if directory:
            path_widget.setText(directory)
            
    def browse_output_file(self, path_widget, file_filter):
        """Browse for output file"""
        file_path, _ = QFileDialog.getSaveFileName(self, "Save File", path_widget.text(), file_filter)
        if file_path:
            path_widget.setText(file_path)
            
    def get_gpu_info(self) -> str:
        """Get GPU information"""
        if torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
            gpu_memory = torch.cuda.get_device_properties(0).total_memory / 1024**3
            return f"✅ GPU: {gpu_name} ({gpu_memory:.1f} GB)"
        return "⚠ No GPU detected"
        
    def download_model(self, model_type: str):
        """Download model based on type"""
        if model_type == "tts":
            model_key = self.get_selected_tts_model_key()
            if not model_key:
                return
            model_info = self.tts_models[model_key]
            storage = Path(self.tts_storage_path.text())
            model_dir = storage / model_info['id'].split('/')[-1]
            progress_bar = self.tts_progress_bar
            download_btn = self.tts_download_btn
            status_label = self.tts_status_label
            log_widget = self.tts_log
        else:  # image
            model_key = self.get_selected_image_model_key()
            if not model_key:
                return
            model_info = self.image_models[model_key]
            storage = Path(self.img_storage_path.text())
            model_dir = storage / model_info['id'].split('/')[-1]
            progress_bar = self.img_progress_bar
            download_btn = self.img_download_btn
            status_label = self.img_status_label
            log_widget = self.img_log
            
        # Confirm
        reply = QMessageBox.question(
            self, 'Confirm Download',
            f'Download {model_info["id"]}?\n\n'
            f'Size: {model_info.get("size", "Unknown")}\n'
            f'Location: {model_dir}\n\n'
            f'This requires several GB of space.',
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )
        
        if reply != QMessageBox.StandardButton.Yes:
            return
            
        model_dir.mkdir(parents=True, exist_ok=True)
        
        progress_bar.setVisible(True)
        progress_bar.setValue(0)
        download_btn.setEnabled(False)
        status_label.setText("Status: Downloading...")
        log_widget.append(f"Downloading {model_info['id']}...")
        
        self.download_worker = ModelDownloadWorker(model_info['id'], str(model_dir), model_type)
        self.download_worker.progress.connect(lambda p, s: progress_bar.setValue(p))
        self.download_worker.log.connect(lambda msg: log_widget.append(msg))
        self.download_worker.finished.connect(
            lambda success, msg: self.download_finished(success, msg, model_type)
        )
        self.download_worker.start()
        
    def download_finished(self, success: bool, message: str, model_type: str):
        """Handle download completion"""
        if model_type == "tts":
            progress_bar = self.tts_progress_bar
            download_btn = self.tts_download_btn
            status_label = self.tts_status_label
        else:
            progress_bar = self.img_progress_bar
            download_btn = self.img_download_btn
            status_label = self.img_status_label
            
        progress_bar.setVisible(False)
        download_btn.setEnabled(True)
        
        if success:
            status_label.setText("Status: Download complete ✅")
            QMessageBox.information(self, "Success", message)
        else:
            status_label.setText("Status: Download failed ❌")
            QMessageBox.warning(self, "Error", message)
            
    def get_selected_tts_model_key(self) -> Optional[str]:
        """Get selected TTS model key"""
        current = self.tts_model_combo.currentText()
        for key in self.tts_models:
            if key in current:
                return key
        return None
        
    def get_selected_image_model_key(self) -> Optional[str]:
        """Get selected image model key"""
        current = self.img_model_combo.currentText()
        for key in self.image_models:
            if key in current:
                return key
        return None
        
    def load_tts_model(self):
        """Load TTS model from local directory"""
        if Qwen3TTSModel is None:
            QMessageBox.critical(self, "Error", "qwen-tts not installed. Run: pip install qwen-tts")
            return
            
        directory = QFileDialog.getExistingDirectory(self, "Select TTS Model Directory", self.tts_storage_path.text())
        if not directory:
            return
            
        try:
            use_gpu = self.tts_use_gpu.isChecked() and torch.cuda.is_available()
            device_map = "cuda:0" if use_gpu else "cpu"
            dtype = torch.bfloat16 if use_gpu else torch.float32
            attn_impl = "flash_attention_2" if (use_gpu and self.tts_use_flash.isChecked()) else "sdpa"
            
            self.tts_status_label.setText("Loading TTS model...")
            self.tts_log.append(f"Loading from: {directory}")
            QApplication.processEvents()
            
            self.tts_model = Qwen3TTSModel.from_pretrained(
                directory,
                device_map=device_map,
                dtype=dtype,
                attn_implementation=attn_impl if attn_impl != "eager" else "eager",
            )
            
            # Update speakers
            if hasattr(self.tts_model, 'get_supported_speakers'):
                speakers = self.tts_model.get_supported_speakers()
                self.tts_voice_combo.clear()
                for speaker in speakers:
                    if speaker in self.speakers:
                        info = self.speakers[speaker]
                        self.tts_voice_combo.addItem(f"{speaker} ({info['language']} - {info['gender']})")
                    else:
                        self.tts_voice_combo.addItem(speaker)
                        
            self.tts_status_label.setText("TTS Model loaded ✅")
            self.tts_log.append("✅ TTS Model ready!")
            QMessageBox.information(self, "Success", "TTS model loaded successfully!")
            
        except Exception as e:
            self.tts_status_label.setText("Failed to load ❌")
            self.tts_log.append(f"❌ Error: {str(e)}")
            QMessageBox.critical(self, "Error", f"Failed to load model:\n{str(e)}")
            
    def load_image_model(self):
        """Load image generation model from local directory"""
        if StableDiffusion3Pipeline is None:
            QMessageBox.critical(self, "Error", "diffusers not installed. Run: pip install diffusers")
            return
            
        directory = QFileDialog.getExistingDirectory(self, "Select Image Model Directory", self.img_storage_path.text())
        if not directory:
            return
            
        model_key = self.get_selected_image_model_key()
        if not model_key:
            return
            
        model_info = self.image_models[model_key]
        
        try:
            use_gpu = self.img_use_gpu.isChecked() and torch.cuda.is_available()
            dtype = torch.float16 if use_gpu else torch.float32
            
            self.img_status_label.setText("Loading image model...")
            self.img_log.append(f"Loading from: {directory}")
            QApplication.processEvents()
            
            if model_info.get('type') == 'lora':
                # Load base model + LoRA
                self.img_log.append("Loading base SD3.5 Medium...")
                self.image_pipe = StableDiffusion3Pipeline.from_pretrained(
                    "stabilityai/stable-diffusion-3.5-medium",
                    torch_dtype=dtype,
                )
                
                # Download/load LoRA
                lora_path = os.path.join(directory, model_info['lora_file'])
                if not os.path.exists(lora_path):
                    self.img_log.append("Downloading LoRA weights...")
                    lora_path = hf_hub_download(
                        model_info['lora_id'],
                        model_info['lora_file'],
                        local_dir=directory
                    )
                
                self.image_pipe.load_lora_weights(lora_path)
                self.image_pipe.fuse_lora()
            else:
                # Load checkpoint directly
                self.image_pipe = StableDiffusion3Pipeline.from_pretrained(
                    directory,
                    torch_dtype=dtype,
                )
            
            if use_gpu:
                self.image_pipe = self.image_pipe.to("cuda")
                
            self.img_status_label.setText("Image Model loaded ✅")
            self.img_log.append("✅ Image model ready!")
            QMessageBox.information(self, "Success", "Image model loaded successfully!")
            
        except Exception as e:
            self.img_status_label.setText("Failed to load ❌")
            self.img_log.append(f"❌ Error: {str(e)}")
            QMessageBox.critical(self, "Error", f"Failed to load model:\n{str(e)}")
            
    def update_tts_voice_info(self):
        """Update TTS voice info"""
        current = self.tts_voice_combo.currentText()
        speaker_name = current.split(' (')[0]
        if speaker_name in self.speakers:
            info = self.speakers[speaker_name]
            self.tts_voice_info.setText(f"📝 {info['description']} | 🌍 {info['language']} | 👤 {info['gender']}")
            
    def set_tts_tone_preset(self, preset: str):
        """Set TTS tone preset"""
        preset_map = {
            "😊 Happy": "Speak in a very happy and cheerful tone",
            "😢 Sad": "Speak in a sad, melancholic tone, slow and emotional",
            "😠 Angry": "Speak in an angry and frustrated tone",
            "🤫 Whisper": "Speak in a soft whisper, very quiet",
            "🎯 Professional": "Speak in a professional, clear tone",
            "🤗 Warm": "Speak in a warm, friendly tone"
        }
        if preset in preset_map:
            self.tts_tone_input.setText(preset_map[preset])
            
    def apply_style_preset(self, style: str):
        """Apply image style preset"""
        if style == "None" or style not in self.style_presets:
            return
        preset = self.style_presets[style]
        current = self.img_negative_prompt.toPlainText().strip()
        if not current:
            self.img_negative_prompt.setText(preset['negative'])
            
    def generate_speech(self):
        """Generate speech from text"""
        if self.tts_model is None:
            QMessageBox.warning(self, "No Model", "Load a TTS model first!")
            return
            
        text = self.tts_text_input.toPlainText().strip()
        if not text:
            QMessageBox.warning(self, "No Text", "Enter text to convert!")
            return
            
        speaker = self.tts_voice_combo.currentText().split(' (')[0]
        language = self.tts_lang_combo.currentText()
        instruct = self.tts_tone_input.text().strip()
        output_path = self.tts_output_path.text().strip() or "tts_output.wav"
        
        self.tts_generate_btn.setEnabled(False)
        self.tts_status_label.setText("Generating speech...")
        self.tts_log.append(f"Generating: {text[:50]}...")
        
        self.tts_worker = TTSWorker(self.tts_model, text, language, speaker, instruct, output_path)
        self.tts_worker.finished.connect(self.tts_generation_finished)
        self.tts_worker.progress.connect(lambda msg: self.tts_log.append(msg))
        self.tts_worker.start()
        
    def tts_generation_finished(self, success: bool, message: str, audio_data, sample_rate: int):
        """Handle TTS generation completion"""
        self.tts_generate_btn.setEnabled(True)
        
        if success:
            self.current_audio = audio_data
            self.current_sr = sample_rate
            self.tts_status_label.setText("Speech generated ✅")
            self.tts_play_btn.setEnabled(True)
            self.tts_log.append(f"✅ {message}")
            QMessageBox.information(self, "Success", f"Saved to: {self.tts_output_path.text()}")
        else:
            self.tts_status_label.setText("Generation failed ❌")
            self.tts_log.append(f"❌ {message}")
            QMessageBox.warning(self, "Error", message)
            
    def play_audio(self):
        """Play generated audio"""
        if self.current_audio is None:
            return
        try:
            import pygame
            pygame.mixer.init(frequency=self.current_sr)
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
                sf.write(tmp.name, self.current_audio[0], self.current_sr)
                pygame.mixer.music.load(tmp.name)
                pygame.mixer.music.play()
            self.tts_stop_btn.setEnabled(True)
        except ImportError:
            output_path = self.tts_output_path.text()
            if os.path.exists(output_path):
                import platform
                if platform.system() == 'Darwin':
                    subprocess.Popen(['afplay', output_path])
                elif platform.system() == 'Windows':
                    os.startfile(output_path)
                else:
                    subprocess.Popen(['xdg-open', output_path])
                    
    def stop_audio(self):
        """Stop audio playback"""
        try:
            import pygame
            pygame.mixer.music.stop()
            self.tts_stop_btn.setEnabled(False)
        except:
            pass
            
    def generate_image(self):
        """Generate image from prompt"""
        if self.image_pipe is None:
            QMessageBox.warning(self, "No Model", "Load an image model first!")
            return
            
        prompt = self.img_prompt.toPlainText().strip()
        if not prompt:
            QMessageBox.warning(self, "No Prompt", "Enter an image prompt!")
            return
            
        # Apply style prefix if selected
        style = self.img_style_combo.currentText()
        if style != "None" and style in self.style_presets:
            prompt = self.style_presets[style]['prompt_prefix'] + prompt
            
        negative = self.img_negative_prompt.toPlainText().strip()
        width = int(self.img_width.currentText())
        height = int(self.img_height.currentText())
        steps = self.img_steps.value()
        guidance = self.img_guidance.value()
        seed = self.img_seed.value()
        output_path = self.img_output_path.text().strip() or "generated_image.png"
        
        self.img_generate_btn.setEnabled(False)
        self.img_gen_progress.setVisible(True)
        self.img_gen_progress.setMaximum(steps)
        self.img_status_label.setText("Generating image...")
        self.img_log.append(f"Generating: {prompt[:50]}...")
        
        self.image_worker = ImageGenWorker(
            self.image_pipe, prompt, negative, width, height,
            steps, guidance, seed, output_path
        )
        self.image_worker.finished.connect(self.image_generation_finished)
        self.image_worker.progress.connect(self.update_image_progress)
        self.image_worker.start()
        
    def update_image_progress(self, message: str, step: int):
        """Update image generation progress"""
        self.img_gen_progress.setValue(step)
        self.img_log.append(f"Step {step}: {message}")
        
    def image_generation_finished(self, success: bool, message: str, image):
        """Handle image generation completion"""
        self.img_generate_btn.setEnabled(True)
        self.img_gen_progress.setVisible(False)
        
        if success and image:
            self.current_image = image
            
            # Display image
            pixmap = self.pil_to_pixmap(image)
            scaled = pixmap.scaled(
                self.img_display.size(),
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation
            )
            self.img_display.setPixmap(scaled)
            
            self.img_status_label.setText("Image generated ✅")
            self.img_log.append(f"✅ {message}")
            QMessageBox.information(self, "Success", f"Saved to: {self.img_output_path.text()}")
        else:
            self.img_status_label.setText("Generation failed ❌")
            self.img_log.append(f"❌ {message}")
            QMessageBox.warning(self, "Error", message)
            
    def pil_to_pixmap(self, pil_image):
        """Convert PIL Image to QPixmap"""
        if pil_image.mode == "RGB":
            r, g, b = pil_image.split()
            pil_image = Image.merge("RGB", (b, g, r))
        elif pil_image.mode == "RGBA":
            r, g, b, a = pil_image.split()
            pil_image = Image.merge("RGBA", (b, g, r, a))
            
        im = pil_image.convert("RGBA")
        data = im.tobytes("raw", "RGBA")
        qim = QImage(data, im.size[0], im.size[1], QImage.Format.Format_RGBA8888)
        return QPixmap.fromImage(qim)
        
    def closeEvent(self, event):
        """Clean up on close"""
        if self.download_worker and self.download_worker.isRunning():
            self.download_worker.cancel()
        if self.tts_worker and self.tts_worker.isRunning():
            self.tts_worker.wait(1000)
        if self.image_worker and self.image_worker.isRunning():
            self.image_worker.wait(1000)
            
        if self.tts_model:
            del self.tts_model
        if self.image_pipe:
            del self.image_pipe
            
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        event.accept()


def main():
    """Main entry point"""
    print("=" * 70)
    print("  AI Generation Studio")
    print("  Text-to-Speech & Text-to-Image")
    print("=" * 70)
    
    if sys.version_info < (3, 10):
        print("❌ Python 3.10+ required")
        sys.exit(1)
        
    app = QApplication(sys.argv)
    app.setStyle('Fusion')
    
    window = MultiModalAIGUI()
    window.show()
    
    sys.exit(app.exec())


if __name__ == "__main__":
    main()