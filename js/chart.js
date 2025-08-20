class ResultsViewer {
    constructor(results, videoFile) {
        this.results = results;
        this.videoFile = videoFile;
        this.chart = null;
        this.video = null;
        
        this.initializeResults();
    }

    initializeResults() {
        // メタデータ表示
        this.displayMetadata();
        
        // 動画設定
        this.setupVideo();
        
        // チャート初期化
        this.initializeChart();
        
        // 新しい解析ボタン
        document.getElementById('newAnalysisBtn').addEventListener('click', () => {
            this.resetToUpload();
        });
    }

    displayMetadata() {
        const metadata = this.results.metadata;
        const metadataEl = document.getElementById('analysisMetadata');
        
        metadataEl.innerHTML = `
            <div class="metadata-grid">
                <div class="metadata-item">
                    <strong>H5ファイル:</strong> ${metadata.filename}
                </div>
                <div class="metadata-item">
                    <strong>動画ファイル:</strong> ${metadata.videoFilename || 'なし'}
                </div>
                <div class="metadata-item">
                    <strong>FPS:</strong> ${metadata.settings.fps}
                </div>
                <div class="metadata-item">
                    <strong>ウィンドウサイズ:</strong> ${metadata.settings.windowSec}秒
                </div>
                <div class="metadata-item">
                    <strong>信頼度しきい値:</strong> ${metadata.settings.confidence}
                </div>
                <div class="metadata-item">
                    <strong>解析時刻:</strong> ${new Date(metadata.timestamp).toLocaleString('ja-JP')}
                </div>
                <div class="metadata-item">
                    <strong>データポイント数:</strong> ${this.results.metrics.length}
                </div>
                <div class="metadata-item">
                    <strong>平均Playfulness:</strong> ${this.calculateAveragePlayfulness().toFixed(3)}
                </div>
            </div>
        `;
    }

    calculateAveragePlayfulness() {
        const playIndices = this.results.metrics.map(m => m.playIndex);
        return playIndices.reduce((sum, val) => sum + val, 0) / playIndices.length;
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
                    <button onclick="uploadVideo()" class="upload-video-btn">
                        動画をアップロード
                    </button>
                </div>
                <div class="time-info">
                    グラフ時刻: <span id="currentTime">0.0</span>秒
                </div>
            `;
        }

        // 時間更新の設定
        if (this.video) {
            this.video.addEventListener('timeupdate', () => {
                this.updateTimeDisplay();
                this.updateChartMarker();
            });
        }
    }

    initializeChart() {
        const ctx = document.getElementById('playChart').getContext('2d');
        
        // データ準備
        const data = this.results.metrics.map(metric => ({
            x: metric.timeCenter,
            y: metric.playIndex
        }));

        // Chart.js時間マーカープラグイン
        const timeMarkerPlugin = {
            id: 'timeMarker',
            afterDraw: (chart) => {
                if (!this.video) return;
                
                const {ctx, scales, chartArea} = chart;
                const xScale = scales.x;
                const currentTime = this.getCurrentTime();
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
                    
                    // 現在時刻ラベル
                    ctx.fillStyle = '#ff4444';
                    ctx.font = 'bold 12px Arial';
                    ctx.fillText(`${currentTime.toFixed(1)}s`, x + 5, chartArea.top + 20);
                    ctx.restore();
                }
            }
        };

        Chart.register(timeMarkerPlugin);

        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [{
                    label: 'Playfulness Index',
                    data: data,
                    borderColor: 'rgb(255, 99, 132)',
                    backgroundColor: 'rgba(255, 99, 132, 0.1)',
                    borderWidth: 3,
                    pointRadius: 5,
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
                        position: 'top',
                        labels: {
                            font: {
                                size: 14,
                                weight: 'bold'
                            }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            title: (context) => {
                                return `時刻: ${context[0].parsed.x.toFixed(1)}秒`;
                            },
                            label: (context) => {
                                return `Playfulness: ${context.parsed.y.toFixed(3)}`;
                            }
                        },
                        backgroundColor: 'rgba(0,0,0,0.8)',
                        titleColor: '#fff',
                        bodyColor: '#fff',
                        borderColor: 'rgb(255, 99, 132)',
                        borderWidth: 2
                    }
                },
                scales: {
                    x: {
                        type: 'linear',
                        title: {
                            display: true,
                            text: '時間 (秒)',
                            font: {
                                size: 14,
                                weight: 'bold'
                            }
                        },
                        grid: {
                            color: 'rgba(0,0,0,0.1)'
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Playfulness Index',
                            font: {
                                size: 14,
                                weight: 'bold'
                            }
                        },
                        min: 0,
                        max: 1,
                        grid: {
                            color: 'rgba(0,0,0,0.1)'
                        }
                    }
                },
                animation: {
                    duration: 1000,
                    easing: 'easeInOutQuart'
                }
            }
        });

        // チャートクリックでビデオシーク
        this.chart.canvas.addEventListener('click', (event) => {
            const points = this.chart.getElementsAtEventForMode(event, 'nearest', { intersect: false }, false);
            if (points.length > 0) {
                const clickedTime = this.chart.data.datasets[0].data[points[0].index].x;
                this.seekToTime(clickedTime);
            }
        });

        // チャートホバー効果
        this.chart.canvas.addEventListener('mousemove', (event) => {
            const points = this.chart.getElementsAtEventForMode(event, 'nearest', { intersect: false }, false);
            this.chart.canvas.style.cursor = points.length > 0 ? 'pointer' : 'default';
        });
    }

    getCurrentTime() {
        if (this.video && !isNaN(this.video.currentTime)) {
            return this.video.currentTime;
        }
        return 0;
    }

    updateTimeDisplay() {
        const currentTime = this.getCurrentTime();
        document.getElementById('currentTime').textContent = currentTime.toFixed(1);
    }

    updateChartMarker() {
        if (this.chart) {
            this.chart.update('none');
        }
    }

    seekToTime(time) {
        if (this.video) {
            this.video.currentTime = Math.max(0, Math.min(this.video.duration || 0, time));
        }
        
        // 動画がない場合は時刻表示のみ更新
        document.getElementById('currentTime').textContent = time.toFixed(1);
        this.updateChartMarker();
    }

    resetToUpload() {
        // 結果画面を非表示
        document.getElementById('resultsScreen').classList.add('hidden');
        document.getElementById('uploadScreen').classList.remove('hidden');
        
        // リソースをクリーンアップ
        if (this.video && this.video.src) {
            URL.revokeObjectURL(this.video.src);
        }
        
        if (this.chart) {
            this.chart.destroy();
        }
        
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

function uploadVideo() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            const video = document.getElementById('resultVideo');
            if (video) {
                video.src = URL.createObjectURL(file);
                video.style.display = 'block';
                document.querySelector('.no-video').style.display = 'none';
            }
        }
    };
    input.click();
}

function exportResults() {
    if (!window.resultsViewer) return;
    
    const results = window.resultsViewer.results;
    
    // CSVデータを生成
    const csvHeader = 'timeCenter,playIndex,tailAngle,wagFreq,earAngle\n';
    const csvData = results.metrics.map(m => 
        `${m.timeCenter},${m.playIndex},${m.tailAngle},${m.wagFreq},${m.earAngle}`
    ).join('\n');
    
    const csvContent = csvHeader + csvData;
    
    // JSONメタデータ
    const jsonContent = JSON.stringify(results, null, 2);
    
    // ZIPファイルを作成
    const zip = new JSZip();
    zip.file('playfulness_metrics.csv', csvContent);
    zip.file('analysis_metadata.json', jsonContent);
    
    // ダウンロード
    zip.generateAsync({type: 'blob'}).then(function(content) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(content);
        link.download = `cat_analysis_${new Date().toISOString().split('T')[0]}.zip`;
        link.click();
    });
}
