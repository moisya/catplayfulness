class FileUploader {
    constructor() {
        this.h5File = null;
        this.videoFile = null;
        this.initializeUploadAreas();
    }

    initializeUploadAreas() {
        // H5ファイルアップロード
        const h5Area = document.getElementById('h5UploadArea');
        const h5Input = document.getElementById('h5Input');
        
        h5Area.addEventListener('click', () => h5Input.click());
        h5Area.addEventListener('dragover', this.handleDragOver);
        h5Area.addEventListener('drop', (e) => this.handleDrop(e, 'h5'));
        h5Input.addEventListener('change', (e) => this.handleFileSelect(e, 'h5'));
        
        // 動画ファイルアップロード
        const videoArea = document.getElementById('videoUploadArea');
        const videoInput = document.getElementById('videoInput');
        
        videoArea.addEventListener('click', () => videoInput.click());
        videoArea.addEventListener('dragover', this.handleDragOver);
        videoArea.addEventListener('drop', (e) => this.handleDrop(e, 'video'));
        videoInput.addEventListener('change', (e) => this.handleFileSelect(e, 'video'));
        
        // 解析ボタン
        document.getElementById('analyzeBtn').addEventListener('click', () => {
            this.startAnalysis();
        });
    }

    handleDragOver(e) {
        e.preventDefault();
        e.currentTarget.classList.add('drag-over');
    }

    handleDrop(e, type) {
        e.preventDefault();
        e.currentTarget.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            this.processFile(files[0], type);
        }
    }

    handleFileSelect(e, type) {
        const file = e.target.files[0];
        if (file) {
            this.processFile(file, type);
        }
    }

    processFile(file, type) {
        if (type === 'h5') {
            if (!file.name.toLowerCase().endsWith('.h5')) {
                alert('H5ファイルを選択してください');
                return;
            }
            this.h5File = file;
            this.updateFileInfo('h5FileInfo', file);
        } else if (type === 'video') {
            if (!file.type.startsWith('video/')) {
                alert('動画ファイルを選択してください');
                return;
            }
            this.videoFile = file;
            this.updateFileInfo('videoFileInfo', file);
        }
        
        this.updateAnalyzeButton();
    }

    updateFileInfo(elementId, file) {
        const info = document.getElementById(elementId);
        const size = (file.size / 1024 / 1024).toFixed(2);
        info.innerHTML = `
            <div class="file-selected">
                ✅ ${file.name}<br>
                サイズ: ${size} MB
            </div>
        `;
    }

    updateAnalyzeButton() {
        const btn = document.getElementById('analyzeBtn');
        btn.disabled = !this.h5File;
        if (this.h5File) {
            btn.textContent = '🚀 解析開始';
            btn.classList.add('ready');
        }
    }

    async startAnalysis() {
        if (!this.h5File) return;
        
        // 画面切り替え
        document.getElementById('uploadScreen').classList.add('hidden');
        document.getElementById('analysisScreen').classList.remove('hidden');
        
        // 解析実行
        const analyzer = new CatAnalyzer();
        const settings = {
            fps: parseFloat(document.getElementById('fpsInput').value),
            windowSec: parseFloat(document.getElementById('windowInput').value),
            confidence: parseFloat(document.getElementById('confidenceInput').value)
        };
        
        try {
            const results = await analyzer.analyze(this.h5File, this.videoFile, settings);
            this.showResults(results);
        } catch (error) {
            alert('解析中にエラーが発生しました: ' + error.message);
            this.resetToUpload();
        }
    }

    showResults(results) {
        document.getElementById('analysisScreen').classList.add('hidden');
        document.getElementById('resultsScreen').classList.remove('hidden');
        
        // 結果を表示
        window.resultsViewer = new ResultsViewer(results, this.videoFile);
    }

    resetToUpload() {
        document.getElementById('analysisScreen').classList.add('hidden');
        document.getElementById('resultsScreen').classList.add('hidden');
        document.getElementById('uploadScreen').classList.remove('hidden');
    }
}
