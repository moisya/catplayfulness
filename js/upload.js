class FileUploader {
    constructor() {
        this.csvFile = null;
        this.videoFile = null;
        this.initializeUploadAreas();
    }

    initializeUploadAreas() {
        // CSVファイルアップロード
        const csvArea = document.getElementById('csvUploadArea');
        const csvInput = document.getElementById('csvInput');
        
        csvArea.addEventListener('click', () => csvInput.click());
        csvArea.addEventListener('dragover', this.handleDragOver);
        csvArea.addEventListener('drop', (e) => this.handleDrop(e, 'csv'));
        csvInput.addEventListener('change', (e) => this.handleFileSelect(e, 'csv'));
        
        // 動画ファイルアップロード（既存と同じ）
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

    processFile(file, type) {
        if (type === 'csv') {
            if (!file.name.toLowerCase().endsWith('.csv')) {
                alert('CSVファイルを選択してください');
                return;
            }
            this.csvFile = file;
            this.updateFileInfo('csvFileInfo', file);
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

    updateAnalyzeButton() {
        const btn = document.getElementById('analyzeBtn');
        btn.disabled = !this.csvFile;
        if (this.csvFile) {
            btn.textContent = '🚀 解析開始';
            btn.classList.add('ready');
        }
    }

    async startAnalysis() {
        if (!this.csvFile) return;
        
        // 画面切り替え
        document.getElementById('uploadScreen').classList.add('hidden');
        document.getElementById('analysisScreen').classList.remove('hidden');
        
        // 解析実行
        const analyzer = new CSVCatAnalyzer();
        const settings = {
            fps: parseFloat(document.getElementById('fpsInput').value),
            windowSec: parseFloat(document.getElementById('windowInput').value),
            confidence: parseFloat(document.getElementById('confidenceInput').value)
        };
        
        try {
            const results = await analyzer.analyze(this.csvFile, this.videoFile, settings);
            this.showResults(results);
        } catch (error) {
            alert('解析中にエラーが発生しました: ' + error.message);
            console.error('Analysis error:', error);
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

    // 既存のメソッド（handleDragOver, handleDrop, handleFileSelect, updateFileInfo）
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
}
