class EnhancedResultsViewer {
    constructor(results, videoFile) {
        this.results = results;
        this.videoFile = videoFile;
        this.charts = {};
        this.video = null;
        this.currentMetricIndex = 0;
        
        this.initializeEnhancedResults();
    }

    initializeEnhancedResults() {
        // メタデータ表示
        this.displayMetadata();
        
        // 動画設定
        this.setupVideo();
        
        // メインチャート初期化
        this.initializeMainChart();
        
        // 特徴量ミニチャート初期化
        this.initializeMiniCharts();
        
        // 詳細テーブル初期化
        this.initializeDetailedTable();
        
        // リアルタイム更新開始
        this.startRealtimeUpdates();
        
        // 新しい解析ボタン
        document.getElementById('newAnalysisBtn').addEventListener('click', () => {
            this.resetToUpload();
        });
    }

    displayMetadata() {
        const metadata = this.results.metadata;
        const metadataEl = document.getElementById('analysisMetadata');
        
        const avgPlayfulness = this.results.metrics.reduce((sum, m) => sum + m.playIndex, 0) / this.results.metrics.length;
        const minPlayfulness = Math.min(...this.results.metrics.map(m => m.playIndex));
        const maxPlayfulness = Math.max(...this.results.metrics.map(m => m.playIndex));
        
        metadataEl.innerHTML = `
            <div class="metadata-grid">
                <div class="metadata-item">
                    <strong>📁 ファイル:</strong> ${metadata.filename}
                </div>
                <div class="metadata-item">
                    <strong>🎥 動画:</strong> ${metadata.videoFilename || 'なし'}
                </div>
                <div class="metadata-item">
                    <strong>⏱️ 解析時刻:</strong> ${new Date(metadata.timestamp).toLocaleString('ja-JP')}
                </div>
                <div class="metadata-item">
                    <strong>📊 データポイント:</strong> ${metadata.dataPoints}個
                </div>
                <div class="metadata-item">
                    <strong>🎯 平均Playfulness:</strong> ${avgPlayfulness.toFixed(3)}
                </div>
                <div class="metadata-item">
                    <strong>📈 範囲:</strong> ${minPlayfulness.toFixed(3)} - ${maxPlayfulness.toFixed(3)}
                </div>
                <div class="metadata-item">
                    <strong>🔧 設定:</strong> FPS:${metadata.settings.fps}, ウィンドウ:${metadata.settings.windowSec}s
                </div>
                <div class="metadata-item">
                    <strong>🐱 検出身体部位:</strong> ${metadata.bodyparts.length}個
                </div>
            </div>
        `;
    }

    setupVideo() {
        this.video = document.getElementById('resultVideo');
        
        if (this.videoFile) {
            const videoURL = URL.createObjectURL(this.videoFile);
            this.video.src = videoURL;
            this.video.style.display = 'block';
        } else {
            // 動画がない場合の表示
            const videoSection = document.querySelector('.video-section');
            videoSection.innerHTML = `
                <h3>🎥 動画</h3>
                <div class="no-video">
                    <div class="no-video-icon">📹</div>
                    <p>動画ファイルがアップロードされていません</p>
                    <input type="file" accept="video/*" onchange="uploadVideoFile(this)">
                </div>
                <div class="time-info">
                    グラフ時刻: <span id="currentTime">0.0</span>秒
                </div>
            `;
        }
    }

    initializeMainChart() {
        const ctx = document.getElementById('playChart').getContext('2d');
        
        const data = this.results.metrics.map(metric => ({
            x: metric.timeCenter,
            y: metric.playIndex
        }));

        // 時間マーカープラグイン
        const timeMarkerPlugin = {
            id: 'timeMarker',
            afterDraw: (chart) => {
                const currentTime = this.getCurrentTime();
                const {ctx, scales, chartArea} = chart;
                const xScale = scales.x;
                const x = xScale.getPixelForValue(currentTime);
                
                if (x >= chartArea.left && x <= chartArea.right) {
                    ctx.save();
                    ctx.strokeStyle = '#ff4444';
                    ctx.lineWidth = 3;
                    ctx.setLineDash([5, 5]);
                    ctx.beginPath();
                    ctx.moveTo(x, chartArea.top);
                    ctx.lineTo(x, chartArea.bottom);
                    ctx.stroke();
                    
                    // 現在値ラベル
                    const currentMetric = this.getCurrentMetric();
                    if (currentMetric) {
                        ctx.fillStyle = '#ff4444';
                        ctx.font = 'bold 12px Arial';
                        ctx.fillText(`${currentMetric.playIndex.toFixed(3)}`, x + 5, chartArea.top + 20);
                    }
                    ctx.restore();
                }
            }
        };

        Chart.register(timeMarkerPlugin);

        this.charts.main = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [{
                    label: 'Playfulness Index',
                    data: data,
                    borderColor: 'rgb(255, 99, 132)',
                    backgroundColor: 'rgba(255, 99, 132, 0.1)',
                    borderWidth: 3,
                    pointRadius: 4,
                    pointHoverRadius: 8,
                    pointBackgroundColor: 'rgb(255, 99, 132)',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2,
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    intersect: false,
                    mode: 'nearest'
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top'
                    },
                    tooltip: {
                        callbacks: {
                            title: (context) => `時刻: ${context[0].parsed.x.toFixed(1)}秒`,
                            label: (context) => `Playfulness: ${context.parsed.y.toFixed(3)}`
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'linear',
                        title: {
                            display: true,
                            text: '時間 (秒)'
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Playfulness Index'
                        },
                        min: 0,
                        max: 1
                    }
                }
            }
        });

        // チャートクリックでビデオシーク
        this.charts.main.canvas.addEventListener('click', (event) => {
            const points = this.charts.main.getElementsAtEventForMode(event, 'nearest', { intersect: false }, false);
            if (points.length > 0) {
                const clickedTime = this.charts.main.data.datasets[0].data[points[0].index].x;
                this.seekToTime(clickedTime);
            }
        });
    }

    initializeMiniCharts() {
        const chartConfigs = [
            {
                id: 'tailAngleChart',
                label: '尻尾角度 (度)',
                data: this.results.metrics.map(m => ({ x: m.timeCenter, y: m.tailAngleMean || 0 })),
                color: 'rgb(102, 126, 234)'
            },
            {
                id: 'earAngleChart',
                label: '耳角度 (度)',
                data: this.results.metrics.map(m => ({ x: m.timeCenter, y: m.earForwardMean || 0 })),
                color: 'rgb(255, 159, 64)'
            },
            {
                id: 'wagFreqChart',
                label: '振り周波数 (Hz)',
                data: this.results.metrics.map(m => ({ x: m.timeCenter, y: m.wagFreqHz || 0 })),
                color: 'rgb(54, 162, 235)'
            },
            {
                id: 'angularVelChart',
                label: '角速度変動',
                data: this.results.metrics.map(m => ({ x: m.timeCenter, y: m.angVelStd || 0 })),
                color: 'rgb(255, 206, 86)'
            }
        ];

        chartConfigs.forEach(config => {
            const ctx = document.getElementById(config.id).getContext('2d');
            this.charts[config.id] = new Chart(ctx, {
                type: 'line',
                data: {
                    datasets: [{
                        label: config.label,
                        data: config.data,
                        borderColor: config.color,
                        backgroundColor: config.color + '20',
                        borderWidth: 2,
                        pointRadius: 2,
                        tension: 0.4,
                        fill: true
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false }
                    },
                    scales: {
                        x: { display: false },
                        y: { 
                            display: true,
                            beginAtZero: true,
                            ticks: { font: { size: 10 } }
                        }
                    }
                }
            });
        });
    }

    initializeDetailedTable() {
        const tableBody = document.getElementById('detailedDataBody');
        
        this.results.metrics.forEach((metric, index) => {
            const row = document.createElement('tr');
            row.dataset.index = index;
            row.innerHTML = `
                <td>${metric.timeCenter.toFixed(1)}</td>
                <td>${metric.playIndex.toFixed(3)}</td>
                <td>${(metric.tailAngleMean || 0).toFixed(1)}</td>
                <td>${(metric.earForwardMean || 0).toFixed(1)}</td>
                <td>${(metric.tailBendMean || 0).toFixed(1)}</td>
                <td>${(metric.wagFreqHz || 0).toFixed(2)}</td>
                <td>${(metric.angVelStd || 0).toFixed(3)}</td>
            `;
            
            row.addEventListener('click', () => {
                this.seekToTime(metric.timeCenter);
            });
            
            tableBody.appendChild(row);
        });
    }

    startRealtimeUpdates() {
        const updateInterval = setInterval(() => {
            if (this.video && !this.video.paused) {
                this.updateCurrentTimeDisplay();
                this.updateFeatureMeters();
                this.updateTotalScore();
                this.updateTableHighlight();
                this.updateChartMarkers();
            }
        }, 100); // 100msごとに更新

        // 動画が停止したときも更新
        if (this.video) {
            this.video.addEventListener('timeupdate', () => {
                this.updateCurrentTimeDisplay();
                this.updateFeatureMeters();
                this.updateTotalScore();
                this.updateTableHighlight();
            });
        }
    }

    updateCurrentTimeDisplay() {
        const currentTime = this.getCurrentTime();
        document.getElementById('currentTime').textContent = currentTime.toFixed(1);
    }

    updateFeatureMeters() {
        const currentMetric = this.getCurrentMetric();
        
        if (currentMetric) {
            // 実際の特徴量データに基づく更新
            const features = {
                tailUp: this.normalizeValue(90 - (currentMetric.tailAngleMean || 45), 0, 90) * 100, // 角度を反転
                earForward: this.normalizeValue(90 - (currentMetric.earForwardMean || 45), 0, 90) * 100,
                tailBend: this.normalizeValue(currentMetric.tailBendMean || 0, 0, 180) * 100,
                wagFreq: this.normalizeValue(currentMetric.wagFreqHz || 0, 0, 6) * 100,
                angularVel: this.normalizeValue(currentMetric.angVelStd || 0, 0, 50) * 100
            };
            
            // メーターの更新
            this.updateMeter('tailUpMeter', 'tailUpValue', features.tailUp, '度');
            this.updateMeter('earForwardMeter', 'earForwardValue', features.earForward, '度');
            this.updateMeter('tailBendMeter', 'tailBendValue', features.tailBend, '度');
            this.updateMeter('wagFreqMeter', 'wagFreqValue', features.wagFreq, 'Hz', currentMetric.wagFreqHz);
            this.updateMeter('angularVelMeter', 'angularVelValue', features.angularVel, '', currentMetric.angVelStd);
        }
    }

    updateMeter(meterId, valueId, percentage, unit, rawValue = null) {
        const meter = document.getElementById(meterId);
        const valueEl = document.getElementById(valueId);
        
        if (meter && valueEl) {
            meter.style.width = Math.max(0, Math.min(100, percentage)) + '%';
            
            if (rawValue !== null) {
                valueEl.textContent = rawValue.toFixed(2) + unit;
            } else {
                valueEl.textContent = Math.round(percentage) + '%';
            }
        }
    }

    updateTotalScore() {
        const currentMetric = this.getCurrentMetric();
        
        if (currentMetric) {
            const score = currentMetric.playIndex;
            const scoreValue = document.getElementById('totalScoreValue');
            const scoreDesc = document.getElementById('scoreDescription');
            
            if (scoreValue) {
                scoreValue.textContent = score.toFixed(3);
                
                // スコアの説明
                let description = '';
                if (score < 0.3) {
                    description = '😴 リラックス状態';
                } else if (score < 0.5) {
                    description = '🤔 普通の状態';
                } else if (score < 0.7) {
                    description = '😸 やや活発';
                } else {
                    description = '🎯 とても活発！';
                }
                
                if (scoreDesc) {
                    scoreDesc.textContent = description;
                }
            }
            
            // 円形ゲージの色更新
            const circle = document.querySelector('.score-circle');
            if (circle) {
                const rotation = score * 360;
                circle.style.background = `conic-gradient(from 0deg, #28a745 0deg, #28a745 ${rotation}deg, #e9ecef ${rotation}deg, #e9ecef 360deg)`;
            }
        }
    }

    updateTableHighlight() {
        const currentTime = this.getCurrentTime();
        const rows = document.querySelectorAll('#detailedDataBody tr');
        
        // 全ての行のハイライトを削除
        rows.forEach(row => row.classList.remove('current-time'));
        
        // 現在時刻に最も近い行をハイライト
        let closestRow = null;
        let closestDistance = Infinity;
        
        this.results.metrics.forEach((metric, index) => {
            const distance = Math.abs(metric.timeCenter - currentTime);
            if (distance < closestDistance) {
                closestDistance = distance;
                closestRow = rows[index];
            }
        });
        
        if (closestRow) {
            closestRow.classList.add('current-time');
            closestRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    updateChartMarkers() {
        // メインチャートの更新
        if (this.charts.main) {
            this.charts.main.update('none');
        }
    }

    getCurrentTime() {
        if (this.video && !isNaN(this.video.currentTime)) {
            return this.video.currentTime;
        }
        return 0;
    }

    getCurrentMetric() {
        const currentTime = this.getCurrentTime();
        
        // 現在時刻に最も近いメトリクスを見つける
        let closestMetric = null;
        let closestDistance = Infinity;
        
        for (const metric of this.results.metrics) {
            const distance = Math.abs(metric.timeCenter - currentTime);
            if (distance < closestDistance) {
                closestDistance = distance;
                closestMetric = metric;
            }
        }
        
        return closestMetric;
    }

    normalizeValue(value, min, max) {
        return Math.max(0, Math.min(1, (value - min) / (max - min)));
    }

    seekToTime(time) {
        if (this.video) {
            this.video.currentTime = Math.max(0, Math.min(this.video.duration || 0, time));
        }
        
        // 動画がない場合は時刻表示のみ更新
        document.getElementById('currentTime').textContent = time.toFixed(1);
        this.updateFeatureMeters();
        this.updateTotalScore();
        this.updateTableHighlight();
        this.updateChartMarkers();
    }

    resetToUpload() {
        // 結果画面を非表示
        document.getElementById('resultsScreen').classList.add('hidden');
        document.getElementById('uploadScreen').classList.remove('hidden');
        
        // リソースをクリーンアップ
        if (this.video && this.video.src) {
            URL.revokeObjectURL(this.video.src);
        }
        
        // チャートを破棄
        Object.values(this.charts).forEach(chart => {
            if (chart && typeof chart.destroy === 'function') {
                chart.destroy();
            }
        });
        
        // アップローダーをリセット
        window.uploader = new FileUploader();
    }
}

// グローバル関数（ボタンから呼び出される）
function playPause() {
    const video = document.getElementById('resultVideo');
    if (video) {
        if (video.paused) {
            video.play();
        } else {
            video.pause();
        }
    }
}

function seekToTime(seconds) {
    if (window.resultsViewer) {
        window.resultsViewer.seekToTime(seconds);
    }
}

function uploadVideoFile(input) {
    const file = input.files[0];
    if (file) {
        const video = document.getElementById('resultVideo');
        if (video) {
            video.src = URL.createObjectURL(file);
            video.style.display = 'block';
            document.querySelector('.no-video').style.display = 'none';
        }
    }
}

function exportDetailedCSV() {
    if (!window.resultsViewer) return;
    
    const results = window.resultsViewer.results;
    
    // 詳細CSVヘッダー
    const csvHeader = 'Time(s),Playfulness,TailAngle(deg),EarAngle(deg),TailBend(deg),WagFreq(Hz),AngularVel\n';
    
    // 詳細CSVデータ
    const csvData = results.metrics.map(m => {
        return [
            m.timeCenter.toFixed(3),
            m.playIndex.toFixed(4),
            (m.tailAngleMean || 0).toFixed(2),
            (m.earForwardMean || 0).toFixed(2),
            (m.tailBendMean || 0).toFixed(2),
            (m.wagFreqHz || 0).toFixed(3),
            (m.angVelStd || 0).toFixed(4)
        ].join(',');
    }).join('\n');
    
    const csvContent = csvHeader + csvData;
    
    // ダウンロード
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `cat_playfulness_detailed_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
}

function exportImages() {
    if (!window.resultsViewer) return;
    
    const zip = new JSZip();
    const charts = window.resultsViewer.charts;
    
    // 各チャートを画像として保存
    Object.entries(charts).forEach(([name, chart]) => {
        if (chart && chart.canvas) {
            const imageData = chart.canvas.toDataURL('image/png');
            const base64Data = imageData.split(',')[1];
            zip.file(`${name}.png`, base64Data, { base64: true });
        }
    });
    
    // ZIPファイルを生成してダウンロード
    zip.generateAsync({ type: 'blob' }).then(function(content) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(content);
        link.download = `cat_analysis_charts_${new Date().toISOString().split('T')[0]}.zip`;
        link.click();
    });
}

// 既存のResultsViewerクラスを拡張版に置き換え
class ResultsViewer extends EnhancedResultsViewer {
    constructor(results, videoFile) {
        super(results, videoFile);
    }
}
