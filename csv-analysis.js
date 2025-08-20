class MultiHeaderCSVAnalyzer {
    constructor() {
        this.csvData = null;
        this.debugMode = true;
        this.structure = null;
    }

    async analyze(csvFile, videoFile, settings) {
        this.updateProgress(0, 'CSVファイル読み込み中...');
        
        // CSVファイルを読み込み（ヘッダー処理なし）
        const rawLines = await this.readCSVLines(csvFile);
        this.updateProgress(20, '多層ヘッダー解析中...');
        
        // 多層ヘッダーを解析
        const parsedData = await this.parseMultiHeaderCSV(rawLines);
        this.updateProgress(40, '身体部位座標抽出中...');
        
        // 座標データを抽出
        const coordinates = await this.extractCoordinatesFromParsedData(parsedData);
        this.updateProgress(60, 'Playfulness指標計算中...');
        
        // 解析実行
        const metrics = await this.performPlayfulnessAnalysis(coordinates, settings);
        this.updateProgress(80, '結果生成中...');
        
        const results = {
            metrics: metrics,
            metadata: {
                filename: csvFile.name,
                videoFilename: videoFile?.name,
                settings: settings,
                timestamp: new Date().toISOString(),
                totalFrames: parsedData.numFrames,
                individuals: parsedData.individuals,
                bodyparts: parsedData.bodyparts,
                dataPoints: metrics.length,
                structure: this.structure
            }
        };
        
        this.updateProgress(100, '完了！');
        await new Promise(resolve => setTimeout(resolve, 500));
        
        return results;
    }

    async readCSVLines(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const text = e.target.result;
                const lines = text.split('\n').map(line => line.trim()).filter(line => line);
                this.log(`CSV読み込み完了: ${lines.length}行`);
                resolve(lines);
            };
            reader.onerror = () => reject(new Error('ファイル読み込みエラー'));
            reader.readAsText(file);
        });
    }

    async parseMultiHeaderCSV(lines) {
        this.log('多層ヘッダーDeepLabCutファイルを解析中...');
        
        if (lines.length < 5) {
            throw new Error('CSVファイルのヘッダーが不足しています（最低5行必要）');
        }
        
        // ヘッダー行を解析
        const scorerRow = lines[0].split(',');
        const individualRow = lines[1].split(',');
        const bodypartRow = lines[2].split(',');
        const coordRow = lines[3].split(',');
        
        this.log(`カラム数: ${scorerRow.length}`);
        this.log(`スコアラー: ${scorerRow[0]}`);
        this.log(`個体: ${[...new Set(individualRow)].join(', ')}`);
        
        // 構造情報を保存
        this.structure = {
            scorer: scorerRow[0],
            individuals: [...new Set(individualRow)],
            bodyparts: [...new Set(bodypartRow)],
            totalColumns: scorerRow.length
        };
        
        this.log(`身体部位数: ${this.structure.bodyparts.length}`);
        this.log(`身体部位: ${this.structure.bodyparts.slice(0, 10).join(', ')}...`);
        
        // データ行を解析
        const dataLines = lines.slice(4); // ヘッダー4行をスキップ
        const numFrames = dataLines.length;
        
        this.log(`データフレーム数: ${numFrames}`);
        
        return {
            numFrames: numFrames,
            individuals: this.structure.individuals,
            bodyparts: this.structure.bodyparts,
            headers: {
                scorer: scorerRow,
                individual: individualRow,
                bodypart: bodypartRow,
                coord: coordRow
            },
            dataLines: dataLines
        };
    }

    async extractCoordinatesFromParsedData(parsedData) {
        this.log('座標データを抽出中...');
        
        const coordinates = {};
        const likelihood = {};
        const { headers, dataLines } = parsedData;
        
        // 各身体部位の座標を抽出
        for (const bodypart of parsedData.bodyparts) {
            coordinates[bodypart] = { x: [], y: [] };
            likelihood[bodypart] = [];
            
            // この身体部位のx, y, likelihoodカラムを探す
            const indices = this.findBodypartColumns(headers, bodypart);
            
            if (indices.x !== -1 && indices.y !== -1) {
                this.log(`${bodypart}: x=${indices.x}, y=${indices.y}, likelihood=${indices.likelihood}`);
                
                // 各フレームのデータを抽出
                for (const line of dataLines) {
                    const values = line.split(',');
                    
                    const x = parseFloat(values[indices.x]);
                    const y = parseFloat(values[indices.y]);
                    const like = indices.likelihood !== -1 ? parseFloat(values[indices.likelihood]) : 1.0;
                    
                    coordinates[bodypart].x.push(isNaN(x) ? NaN : x);
                    coordinates[bodypart].y.push(isNaN(y) ? NaN : y);
                    likelihood[bodypart].push(isNaN(like) ? 0.0 : like);
                }
            } else {
                this.log(`${bodypart}: 座標カラムが見つかりません`);
                // NaNで埋める
                for (let i = 0; i < dataLines.length; i++) {
                    coordinates[bodypart].x.push(NaN);
                    coordinates[bodypart].y.push(NaN);
                    likelihood[bodypart].push(0.0);
                }
            }
        }
        
        // likelihoodも含める
        coordinates._likelihood = likelihood;
        coordinates._metadata = {
            numFrames: dataLines.length,
            bodyparts: parsedData.bodyparts,
            individuals: parsedData.individuals
        };
        
        return coordinates;
    }

    findBodypartColumns(headers, targetBodypart) {
        const indices = { x: -1, y: -1, likelihood: -1 };
        
        // ヘッダーの各カラムをチェック
        for (let i = 0; i < headers.bodypart.length; i++) {
            if (headers.bodypart[i] === targetBodypart) {
                const coord = headers.coord[i];
                
                if (coord === 'x') {
                    indices.x = i;
                } else if (coord === 'y') {
                    indices.y = i;
                } else if (coord === 'likelihood') {
                    indices.likelihood = i;
                }
            }
        }
        
        return indices;
    }

    async performPlayfulnessAnalysis(coordinates, settings) {
        const { fps = 30, windowSec = 2.0, confidence = 0.5 } = settings;
        const windowFrames = Math.round(windowSec * fps);
        const strideFrames = Math.round(windowFrames / 4);
        
        const numFrames = coordinates._metadata.numFrames;
        const bodyparts = coordinates._metadata.bodyparts;
        
        this.log(`解析設定: frames=${numFrames}, window=${windowFrames}, stride=${strideFrames}`);
        
        // 必要な身体部位を探す
        const bodypartMapping = this.mapRequiredBodyparts(bodyparts);
        this.log(`身体部位マッピング: ${JSON.stringify(bodypartMapping)}`);
        
        // フレームごとの特徴量を計算
        const features = this.calculateFrameFeatures(coordinates, bodypartMapping, confidence);
        
        // ウィンドウ解析
        const metrics = [];
        for (let i = 0; i <= numFrames - windowFrames; i += strideFrames) {
            const windowFeatures = this.extractWindowFeatures(features, i, i + windowFrames);
            const metric = this.calculatePlayfulnessMetrics(windowFeatures, fps);
            
            metrics.push({
                timeCenter: (i + windowFrames/2) / fps,
                ...metric
            });
            
            // 進捗更新
            const progress = 60 + (i / (numFrames - windowFrames)) * 20;
            this.updateProgress(progress, `解析中... ${Math.round(i/numFrames*100)}%`);
            
            if (i % 20 === 0) {
                await new Promise(resolve => setTimeout(resolve, 1));
            }
        }
        
        this.log(`解析完了: ${metrics.length}個のデータポイント`);
        return metrics;
    }

    mapRequiredBodyparts(bodyparts) {
        const mapping = {};
        
        // 必要な身体部位を探す
        const searches = {
            nose: ['nose'],
            tail_base: ['tail_base', 'tailbase'],
            tail_end: ['tail_end', 'tailend', 'tail_tip'],
            left_ear_base: ['left_earbase', 'leftearbase', 'left_ear_base'],
            right_ear_base: ['right_earbase', 'rightearbase', 'right_ear_base'],
            left_ear_end: ['left_earend', 'leftearend', 'left_ear_end'],
            right_ear_end: ['right_earend', 'rightearend', 'right_ear_end'],
            neck_base: ['neck_base', 'neckbase', 'neck'],
            back_base: ['back_base', 'backbase', 'back']
        };
        
        for (const [key, candidates] of Object.entries(searches)) {
            for (const candidate of candidates) {
                const found = bodyparts.find(bp => bp.toLowerCase() === candidate.toLowerCase());
                if (found) {
                    mapping[key] = found;
                    break;
                }
            }
        }
        
        return mapping;
    }

    calculateFrameFeatures(coordinates, bodypartMapping, confidence) {
        const numFrames = coordinates._metadata.numFrames;
        const likelihood = coordinates._likelihood;
        
        const features = {
            tailAngle: [],
            tailMovement: [],
            earPosition: [],
            noseMovement: [],
            overallActivity: []
        };
        
        this.log(`特徴量計算開始: ${numFrames}フレーム`);
        
        for (let i = 0; i < numFrames; i++) {
            // 尻尾の角度計算
            if (bodypartMapping.tail_base && bodypartMapping.tail_end) {
                const tailAngle = this.calculateTailAngle(
                    coordinates, bodypartMapping, likelihood, i, confidence
                );
                features.tailAngle.push(tailAngle);
                
                // 尻尾の動き（前フレームとの差）
                if (i > 0 && !isNaN(features.tailAngle[i-1]) && !isNaN(tailAngle)) {
                    const movement = Math.abs(tailAngle - features.tailAngle[i-1]);
                    features.tailMovement.push(movement);
                } else {
                    features.tailMovement.push(0);
                }
            } else {
                features.tailAngle.push(NaN);
                features.tailMovement.push(0);
            }
            
            // 耳の位置
            const earPos = this.calculateEarPosition(
                coordinates, bodypartMapping, likelihood, i, confidence
            );
            features.earPosition.push(earPos);
            
            // 鼻の動き
            if (bodypartMapping.nose && i > 0) {
                const noseMovement = this.calculateNoseMovement(
                    coordinates, bodypartMapping, likelihood, i, confidence
                );
                features.noseMovement.push(noseMovement);
            } else {
                features.noseMovement.push(0);
            }
            
            // 全体的な活動度
            const activity = this.calculateOverallActivity(
                coordinates, bodypartMapping, likelihood, i, confidence
            );
            features.overallActivity.push(activity);
        }
        
        return features;
    }

    calculateTailAngle(coordinates, mapping, likelihood, frame, confidence) {
        const tailBase = mapping.tail_base;
        const tailEnd = mapping.tail_end;
        
        if (!tailBase || !tailEnd) return NaN;
        
        // 信頼度チェック
        if (likelihood[tailBase][frame] < confidence || likelihood[tailEnd][frame] < confidence) {
            return NaN;
        }
        
        const tbX = coordinates[tailBase].x[frame];
        const tbY = coordinates[tailBase].y[frame];
        const teX = coordinates[tailEnd].x[frame];
        const teY = coordinates[tailEnd].y[frame];
        
        if (isNaN(tbX) || isNaN(tbY) || isNaN(teX) || isNaN(teY)) return NaN;
        
        // 尻尾のベクトル角度（垂直からの角度）
        const dx = teX - tbX;
        const dy = teY - tbY;
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        
        // 垂直から測った角度を返す（0-180度）
        return Math.abs(angle + 90) % 180;
    }

    calculateEarPosition(coordinates, mapping, likelihood, frame, confidence) {
        const leftEar = mapping.left_ear_base;
        const rightEar = mapping.right_ear_base;
        const nose = mapping.nose;
        
        if (!leftEar || !rightEar || !nose) return NaN;
        
        // 信頼度チェック
        if (likelihood[leftEar][frame] < confidence || 
            likelihood[rightEar][frame] < confidence ||
            likelihood[nose][frame] < confidence) {
            return NaN;
        }
        
        const leX = coordinates[leftEar].x[frame];
        const leY = coordinates[leftEar].y[frame];
        const reX = coordinates[rightEar].x[frame];
        const reY = coordinates[rightEar].y[frame];
        const nX = coordinates[nose].x[frame];
        const nY = coordinates[nose].y[frame];
        
        if (isNaN(leX) || isNaN(leY) || isNaN(reX) || isNaN(reY) || isNaN(nX) || isNaN(nY)) {
            return NaN;
        }
        
        // 耳の中点から鼻への角度
        const earCenterX = (leX + reX) / 2;
        const earCenterY = (leY + reY) / 2;
        const angle = Math.atan2(nY - earCenterY, nX - earCenterX) * 180 / Math.PI;
        
        return Math.abs(angle);
    }

    calculateNoseMovement(coordinates, mapping, likelihood, frame, confidence) {
        const nose = mapping.nose;
        if (!nose || frame === 0) return 0;
        
        if (likelihood[nose][frame] < confidence || likelihood[nose][frame-1] < confidence) {
            return 0;
        }
        
        const x1 = coordinates[nose].x[frame-1];
        const y1 = coordinates[nose].y[frame-1];
        const x2 = coordinates[nose].x[frame];
        const y2 = coordinates[nose].y[frame];
        
        if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) return 0;
        
        return Math.sqrt((x2-x1)**2 + (y2-y1)**2);
    }

    calculateOverallActivity(coordinates, mapping, likelihood, frame, confidence) {
        if (frame === 0) return 0;
        
        let totalMovement = 0;
        let validParts = 0;
        
        // 主要な身体部位の動きを計算
        const keyParts = [mapping.nose, mapping.tail_end, mapping.left_ear_base, mapping.right_ear_base];
        
        for (const part of keyParts) {
            if (part && likelihood[part][frame] >= confidence && likelihood[part][frame-1] >= confidence) {
                const x1 = coordinates[part].x[frame-1];
                const y1 = coordinates[part].y[frame-1];
                const x2 = coordinates[part].x[frame];
                const y2 = coordinates[part].y[frame];
                
                if (!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2)) {
                    const movement = Math.sqrt((x2-x1)**2 + (y2-y1)**2);
                    totalMovement += movement;
                    validParts++;
                }
            }
        }
        
        return validParts > 0 ? totalMovement / validParts : 0;
    }

    extractWindowFeatures(features, start, end) {
        const window = {};
        for (const [key, values] of Object.entries(features)) {
            window[key] = values.slice(start, end);
        }
        return window;
    }

    calculatePlayfulnessMetrics(windowFeatures, fps) {
        // 各特徴量の統計値を計算
        const tailAngleMean = this.nanMean(windowFeatures.tailAngle);
        const tailAngleStd = this.nanStd(windowFeatures.tailAngle);
        const tailMovementMean = this.nanMean(windowFeatures.tailMovement);
        const tailMovementStd = this.nanStd(windowFeatures.tailMovement);
        const earPositionMean = this.nanMean(windowFeatures.earPosition);
        const noseMovementMean = this.nanMean(windowFeatures.noseMovement);
        const overallActivityMean = this.nanMean(windowFeatures.overallActivity);
        
        // Playfulness指標の計算（元のアルゴリズムに基づく）
        
        // 1. 尻尾が上がっているかスコア（角度が小さいほど上向き）
        const tailUpScore = Math.max(0, 1.0 - tailAngleMean / 90.0);
        
        // 2. 尻尾の動きの活発さスコア
        const tailActivityScore = Math.min(1.0, tailMovementMean / 20.0);
        
        // 3. 耳が前向きかスコア
        const earForwardScore = Math.max(0, 1.0 - earPositionMean / 90.0);
        
        // 4. 全体的な動きの活発さスコア
        const overallActivityScore = Math.min(1.0, overallActivityMean / 15.0);
        
        // 5. 動きの変動スコア（適度な変動は遊び行動の特徴）
        const variabilityScore = Math.min(1.0, tailAngleStd / 30.0);
        
        // 6. 動きの周波数スコア
        const frequencyScore = this.calculateFrequencyScore(windowFeatures.tailMovement, fps);
        
        // 重み付き総合スコア
        const playIndex = (
            tailUpScore * 0.25 +
            tailActivityScore * 0.20 +
            earForwardScore * 0.20 +
            overallActivityScore * 0.15 +
            variabilityScore * 0.10 +
            frequencyScore * 0.10
        );
        
        return {
            timeCenter: 0, // 後で設定される
            tailAngle: tailAngleMean,
            tailMovement: tailMovementMean,
            tailVariability: tailAngleStd,
            earPosition: earPositionMean,
            noseMovement: noseMovementMean,
            overallActivity: overallActivityMean,
            playIndex: Math.max(0, Math.min(1, playIndex)),
            
            // 詳細スコア
            tailUpScore: tailUpScore,
            tailActivityScore: tailActivityScore,
            earForwardScore: earForwardScore,
            overallActivityScore: overallActivityScore,
            variabilityScore: variabilityScore,
            frequencyScore: frequencyScore
        };
    }

    calculateFrequencyScore(movements, fps) {
        const validMovements = movements.filter(m => !isNaN(m) && m > 0);
        if (validMovements.length < 4) return 0;
        
        // 動きのピークを検出
        const threshold = this.nanMean(validMovements) * 0.5;
        let peaks = 0;
        
        for (let i = 1; i < validMovements.length - 1; i++) {
            if (validMovements[i] > threshold && 
                validMovements[i] > validMovements[i-1] && 
                validMovements[i] > validMovements[i+1]) {
                peaks++;
            }
        }
        
        const frequency = (peaks / validMovements.length) * fps;
        
        // 適度な周波数（1-4Hz）を高く評価
        if (frequency >= 1 && frequency <= 4) {
            return Math.min(1.0, frequency / 3.0);
        } else {
            return Math.max(0, 1.0 - Math.abs(frequency - 2.5) / 2.5);
        }
    }

    nanMean(arr) {
        const valid = arr.filter(x => !isNaN(x) && isFinite(x));
        return valid.length > 0 ? valid.reduce((a, b) => a + b) / valid.length : 0;
    }

    nanStd(arr) {
        const valid = arr.filter(x => !isNaN(x) && isFinite(x));
        if (valid.length <= 1) return 0;
        
        const mean = this.nanMean(valid);
        const variance = valid.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / valid.length;
        return Math.sqrt(variance);
    }

    log(message) {
        console.log(`[MultiHeaderCSV] ${message}`);
        const debugEl = document.getElementById('debugInfo');
        if (debugEl) {
            debugEl.innerHTML += `<div>${message}</div>`;
            debugEl.scrollTop = debugEl.scrollHeight;
        }
    }

    updateProgress(percent, message) {
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        
        if (progressFill) progressFill.style.width = percent + '%';
        if (progressText) progressText.textContent = message;
        
        const steps = ['step1', 'step2', 'step3', 'step4'];
        const currentStep = Math.floor(percent / 25);
        
        steps.forEach((stepId, idx) => {
            const stepEl = document.getElementById(stepId);
            if (stepEl && idx <= currentStep) {
                stepEl.classList.add('completed');
            }
        });
    }
}
