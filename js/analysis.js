class CatAnalyzer {
    constructor() {
        this.progressCallback = this.updateProgress.bind(this);
    }

    async analyze(h5File, videoFile, settings) {
        this.updateProgress(0, 'ファイル読み込み中...');
        
        // H5ファイルを読み込み
        const h5Data = await this.readH5File(h5File);
        this.updateProgress(25, 'データ解析中...');
        
        // 解析実行
        const metrics = await this.performAnalysis(h5Data, settings);
        this.updateProgress(75, '可視化生成中...');
        
        // 結果をまとめる
        const results = {
            metrics: metrics,
            metadata: {
                filename: h5File.name,
                videoFilename: videoFile?.name,
                settings: settings,
                timestamp: new Date().toISOString()
            }
        };
        
        this.updateProgress(100, '完了！');
        await new Promise(resolve => setTimeout(resolve, 500));
        
        return results;
    }

    async readH5File(file) {
        // H5ファイルをArrayBufferとして読み込み
        const buffer = await file.arrayBuffer();
        
        // 簡単なH5パーサー（実際にはより複雑な処理が必要）
        // ここでは例として基本的な処理のみ
        try {
            // H5ファイルの構造を解析
            const data = this.parseH5Buffer(buffer);
            return data;
        } catch (error) {
            throw new Error('H5ファイルの読み込みに失敗しました: ' + error.message);
        }
    }

    parseH5Buffer(buffer) {
        // H5ファイルパーサーの実装
        // 実際にはH5Wasm等のライブラリを使用することを推奨
        
        // ダミーデータ（実際の実装では置き換える）
        const numFrames = 1000;
        const fps = 30;
        
        // 模擬的な座標データ生成
        const data = {
            scorer: 'DLC_resnet50',
            individuals: ['cat1'],
            bodyparts: ['nose', 'tail_base', 'tail_end', 'left_ear', 'right_ear'],
            coordinates: {},
            likelihood: {},
            numFrames: numFrames,
            fps: fps
        };
        
        // 各ボディパーツの座標を生成
        for (const bp of data.bodyparts) {
            data.coordinates[bp] = {
                x: Array.from({length: numFrames}, (_, i) => 
                    300 + 50 * Math.sin(i * 0.1) + Math.random() * 10),
                y: Array.from({length: numFrames}, (_, i) => 
                    200 + 30 * Math.cos(i * 0.1) + Math.random() * 10)
            };
            data.likelihood[bp] = Array.from({length: numFrames}, () => 
                0.5 + Math.random() * 0.5);
        }
        
        return data;
    }

    async performAnalysis(data, settings) {
        const { fps, windowSec, confidence } = settings;
        const windowFrames = Math.round(windowSec * fps);
        const strideFrames = Math.round(windowFrames / 4);
        
        const metrics = [];
        
        // ウィンドウ解析
        for (let i = 0; i <= data.numFrames - windowFrames; i += strideFrames) {
            const windowData = this.extractWindow(data, i, i + windowFrames, confidence);
            const metric = this.calculateMetrics(windowData, fps);
            
            metrics.push({
                timeCenter: (i + windowFrames/2) / fps,
                ...metric
            });
            
            // 進捗更新
            const progress = 25 + (i / (data.numFrames - windowFrames)) * 50;
            this.updateProgress(progress, `解析中... (${i}/${data.numFrames})`);
            
            // UI更新のため少し待機
            if (i % 50 === 0) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
        
        return metrics;
    }

    extractWindow(data, start, end, confidence) {
        const window = {};
        
        for (const bp of data.bodyparts) {
            window[bp] = {
                x: data.coordinates[bp].x.slice(start, end)
                    .map((val, idx) => data.likelihood[bp][start + idx] >= confidence ? val : NaN),
                y: data.coordinates[bp].y.slice(start, end)
                    .map((val, idx) => data.likelihood[bp][start + idx] >= confidence ? val : NaN)
            };
        }
        
        return window;
    }

    calculateMetrics(windowData, fps) {
        // 尻尾の角度計算
        const tailAngle = this.calculateTailAngle(windowData);
        const wagFreq = this.calculateWagFrequency(tailAngle, fps);
        
        // 耳の位置
        const earAngle = this.calculateEarAngle(windowData);
        
        // プレイフル指標計算
        const playIndex = this.calculatePlayIndex(tailAngle, wagFreq, earAngle);
        
        return {
            tailAngle: this.mean(tailAngle),
            wagFreq: wagFreq,
            earAngle: this.mean(earAngle),
            playIndex: playIndex
        };
    }

    calculateTailAngle(data) {
        // 尻尾の角度計算（簡略版）
        const tailBase = data.tail_base;
        const tailEnd = data.tail_end;
        
        if (!tailBase || !tailEnd) return [0];
        
        const angles = [];
        for (let i = 0; i < tailBase.x.length; i++) {
            if (!isNaN(tailBase.x[i]) && !isNaN(tailEnd.x[i])) {
                const dx = tailEnd.x[i] - tailBase.x[i];
                const dy = tailEnd.y[i] - tailBase.y[i];
                const angle = Math.atan2(dy, dx) * 180 / Math.PI;
                angles.push(Math.abs(angle));
            }
        }
        
        return angles;
    }

    calculateWagFrequency(angles, fps) {
        if (angles.length < 8) return 0;
        
        // 簡単な周波数計算
        const variance = this.variance(angles);
        return Math.min(variance / 100, 5); // 0-5Hz範囲
    }

    calculateEarAngle(data) {
        // 耳の角度計算（簡略版）
        const leftEar = data.left_ear;
        const rightEar = data.right_ear;
        const nose = data.nose;
        
        if (!leftEar || !rightEar || !nose) return [0];
        
        const angles = [];
        for (let i = 0; i < nose.x.length; i++) {
            if (!isNaN(nose.x[i]) && !isNaN(leftEar.x[i])) {
                const dx = leftEar.x[i] - nose.x[i];
                const dy = leftEar.y[i] - nose.y[i];
                const angle = Math.atan2(dy, dx) * 180 / Math.PI;
                angles.push(Math.abs(angle));
            }
        }
        
        return angles;
    }

    calculatePlayIndex(tailAngles, wagFreq, earAngles) {
        const tailScore = Math.min(this.variance(tailAngles) / 1000, 1);
        const wagScore = Math.min(wagFreq / 3, 1);
        const earScore = Math.min(this.variance(earAngles) / 500, 1);
        
        return (tailScore * 0.5 + wagScore * 0.3 + earScore * 0.2);
    }

    mean(arr) {
        const valid = arr.filter(x => !isNaN(x));
        return valid.length > 0 ? valid.reduce((a, b) => a + b) / valid.length : 0;
    }

    variance(arr) {
        const valid = arr.filter(x => !isNaN(x));
        if (valid.length <= 1) return 0;
        const avg = this.mean(valid);
        return valid.reduce((sum, x) => sum + Math.pow(x - avg, 2), 0) / valid.length;
    }

    updateProgress(percent, message) {
        document.getElementById('progressFill').style.width = percent + '%';
        document.getElementById('progressText').textContent = message;
        
        // ステップ表示の更新
        const steps = ['step1', 'step2', 'step3', 'step4'];
        const currentStep = Math.floor(percent / 25);
        
        steps.forEach((stepId, idx) => {
            const stepEl = document.getElementById(stepId);
            if (idx <= currentStep) {
                stepEl.classList.add('completed');
            }
        });
    }
}
