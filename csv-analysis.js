class CSVCatAnalyzer {
    constructor() {
        this.csvData = null;
        this.debugMode = true;
    }

    async analyze(csvFile, videoFile, settings) {
        this.updateProgress(0, 'CSVファイル読み込み中...');
        
        // CSVファイルを読み込み
        const rawData = await this.readCSVFile(csvFile);
        this.updateProgress(25, 'データ構造解析中...');
        
        // データ構造を解析
        const parsedData = await this.parseDeepLabCutCSV(rawData);
        this.updateProgress(50, '身体部位座標抽出中...');
        
        // 解析実行
        const metrics = await this.performPlayfulnessAnalysis(parsedData, settings);
        this.updateProgress(75, '結果生成中...');
        
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
                dataPoints: metrics.length
            }
        };
        
        this.updateProgress(100, '完了！');
        await new Promise(resolve => setTimeout(resolve, 500));
        
        return results;
    }

    async readCSVFile(file) {
        return new Promise((resolve, reject) => {
            Papa.parse(file, {
                header: true,
                dynamicTyping: true,
                skipEmptyLines: true,
                complete: (results) => {
                    this.log(`CSV読み込み完了: ${results.data.length}行`);
                    resolve(results.data);
                },
                error: (error) => {
                    this.log(`CSVエラー: ${error.message}`);
                    reject(new Error('CSVファイルの読み込みに失敗しました: ' + error.message));
                }
            });
        });
    }

    async parseDeepLabCutCSV(data) {
        this.log('DeepLabCutデータ構造を解析中...');
        
        if (!data || data.length === 0) {
            throw new Error('CSVファイルが空です');
        }
        
        // カラム名を解析
        const headers = Object.keys(data[0]);
        this.log(`カラム数: ${headers.length}`);
        this.log(`サンプルヘッダー: ${headers.slice(0, 5).join(', ')}...`);
        
        // DeepLabCutの形式を検出
        const structure = this.detectCSVStructure(headers);
        this.log(`検出された構造: ${JSON.stringify(structure)}`);
        
        // 座標データを抽出
        const coordinates = this.extractCoordinates(data, structure);
        
        return {
            numFrames: data.length,
            individuals: structure.individuals,
            bodyparts: structure.bodyparts,
            coordinates: coordinates,
            structure: structure
        };
    }

    detectCSVStructure(headers) {
        const structure = {
            individuals: [],
            bodyparts: [],
            scorers: [],
            format: 'unknown'
        };
        
        // パターン1: scorer_individual_bodypart_coord
        // パターン2: scorer_bodypart_coord (single animal)
        // パターン3: individual_bodypart_coord
        
        const bodypartPattern = /(nose|ear|tail|back|neck|shoulder|hip|knee|ankle|wrist|elbow|spine)/i;
        const coordPattern = /[xy]$/i;
        const likelihoodPattern = /likelihood$/i;
        
        for (const header of headers) {
            const parts = header.split('_');
            
            // 座標列を探す
            if (coordPattern.test(header) || likelihoodPattern.test(header)) {
                // 身体部位を抽出
                for (const part of parts) {
                    if (bodypartPattern.test(part) && !structure.bodyparts.includes(part)) {
                        structure.bodyparts.push(part);
                    }
                }
                
                // 個体名を推測（数字やcat、animalを含む）
                for (const part of parts) {
                    if (/^(cat|animal|individual|\d+)$/i.test(part) && !structure.individuals.includes(part)) {
                        structure.individuals.push(part);
                    }
                }
                
                // スコアラーを推測
                if (parts[0] && !/^(cat|animal|individual|\d+)$/i.test(parts[0]) && !bodypartPattern.test(parts[0])) {
                    if (!structure.scorers.includes(parts[0])) {
                        structure.scorers.push(parts[0]);
                    }
                }
            }
        }
        
        // 個体が見つからない場合はsingle animalとして扱う
        if (structure.individuals.length === 0) {
            structure.individuals = [null];
        }
        
        this.log(`身体部位: ${structure.bodyparts}`);
        this.log(`個体: ${structure.individuals}`);
        this.log(`スコアラー: ${structure.scorers}`);
        
        return structure;
    }

    extractCoordinates(data, structure) {
        const coordinates = {};
        const likelihood = {};
        
        // 各身体部位の座標を抽出
        for (const bodypart of structure.bodyparts) {
            coordinates[bodypart] = { x: [], y: [] };
            likelihood[bodypart] = [];
            
            // カラム名のパターンを試行
            const possiblePatterns = this.generateColumnPatterns(bodypart, structure);
            
            let xCol = null, yCol = null, likeCol = null;
            
            // 最初に見つかったパターンを使用
            for (const pattern of possiblePatterns) {
                if (data[0].hasOwnProperty(pattern.x) && data[0].hasOwnProperty(pattern.y)) {
                    xCol = pattern.x;
                    yCol = pattern.y;
                    likeCol = pattern.likelihood;
                    break;
                }
            }
            
            if (xCol && yCol) {
                this.log(`${bodypart}: x=${xCol}, y=${yCol}, likelihood=${likeCol}`);
                
                for (const row of data) {
                    const x = parseFloat(row[xCol]);
                    const y = parseFloat(row[yCol]);
                    const like = likeCol ? parseFloat(row[likeCol]) : 1.0;
                    
                    coordinates[bodypart].x.push(isNaN(x) ? NaN : x);
                    coordinates[bodypart].y.push(isNaN(y) ? NaN : y);
                    likelihood[bodypart].push(isNaN(like) ? 0.0 : like);
                }
            } else {
                this.log(`${bodypart}: カラムが見つかりません`);
                // ダミーデータで埋める
                for (let i = 0; i < data.length; i++) {
                    coordinates[bodypart].x.push(NaN);
                    coordinates[bodypart].y.push(NaN);
                    likelihood[bodypart].push(0.0);
                }
            }
        }
        
        // likelihoodもcoordinatesに含める
        coordinates._likelihood = likelihood;
        
        return coordinates;
    }

    generateColumnPatterns(bodypart, structure) {
        const patterns = [];
        
        // 様々なカラム名パターンを生成
        const variations = [bodypart, bodypart.toLowerCase(), bodypart.toUpperCase()];
        const coords = ['x', 'y'];
        
        for (const individual of structure.individuals) {
            for (const scorer of [...structure.scorers, '']) {
                for (const bp of variations) {
                    const prefix = [scorer, individual, bp].filter(p => p).join('_');
                    
                    patterns.push({
                        x: `${prefix}_x`,
                        y: `${prefix}_y`,
                        likelihood: `${prefix}_likelihood`
                    });
                    
                    // アンダースコアなしパターン
                    patterns.push({
                        x: `${prefix}x`,
                        y: `${prefix}y`,
                        likelihood: `${prefix}likelihood`
                    });
                }
            }
        }
        
        // シンプルなパターンも追加
        for (const bp of variations) {
            patterns.push({
                x: `${bp}_x`,
                y: `${bp}_y`,
                likelihood: `${bp}_likelihood`
            });
        }
        
        return patterns;
    }

    async performPlayfulnessAnalysis(data, settings) {
        const { fps = 30, windowSec = 2.0, confidence = 0.5 } = settings;
        const windowFrames = Math.round(windowSec * fps);
        const strideFrames = Math.round(windowFrames / 4);
        
        this.log(`解析設定: frames=${data.numFrames}, window=${windowFrames}, stride=${strideFrames}`);
        
        // 必要な身体部位をチェック
        const requiredParts = ['tail_base', 'tail_end', 'nose'];
        const availableParts = data.bodyparts.filter(bp => requiredParts.some(req => 
            bp.toLowerCase().includes(req.toLowerCase())
        ));
        
        this.log(`利用可能な必須部位: ${availableParts}`);
        
        if (availableParts.length === 0) {
            throw new Error('必要な身体部位（tail_base, tail_end, nose）が見つかりません');
        }
        
        // フレームごとの特徴量を計算
        const features = this.calculateFrameFeatures(data, confidence);
        
        // ウィンドウ解析
        const metrics = [];
        for (let i = 0; i <= data.numFrames - windowFrames; i += strideFrames) {
            const windowFeatures = this.extractWindowFeatures(features, i, i + windowFrames);
            const metric = this.calculatePlayfulnessMetrics(windowFeatures, fps);
            
            metrics.push({
                timeCenter: (i + windowFrames/2) / fps,
                ...metric
            });
            
            // 進捗更新
            const progress = 50 + (i / (data.numFrames - windowFrames)) * 25;
            this.updateProgress(progress, `解析中... ${Math.round(i/data.numFrames*100)}%`);
            
            if (i % 50 === 0) {
                await new Promise(resolve => setTimeout(resolve, 1));
            }
        }
        
        this.log(`解析完了: ${metrics.length}個のデータポイント`);
        return metrics;
    }

    calculateFrameFeatures(data, confidence) {
        const features = {
            tailAngle: [],
            tailMovement: [],
            noseTailDistance: [],
            overallMovement: []
        };
        
        const coords = data.coordinates;
        const likelihood = coords._likelihood;
        
        // 利用可能な身体部位を探す
        const tailBase = this.findBodypart(data.bodyparts, ['tail_base', 'tailbase', 'tail']);
        const tailEnd = this.findBodypart(data.bodyparts, ['tail_end', 'tailend', 'tail_tip']);
        const nose = this.findBodypart(data.bodyparts, ['nose', 'snout']);
        
        this.log(`使用する身体部位: tail_base=${tailBase}, tail_end=${tailEnd}, nose=${nose}`);
        
        for (let i = 0; i < data.numFrames; i++) {
            // 尻尾の角度
            if (tailBase && tailEnd && this.isValidPoint(coords, likelihood, tailBase, i, confidence) && 
                this.isValidPoint(coords, likelihood, tailEnd, i, confidence)) {
                
                const tbX = coords[tailBase].x[i];
                const tbY = coords[tailBase].y[i];
                const teX = coords[tailEnd].x[i];
                const teY = coords[tailEnd].y[i];
                
                const angle = Math.atan2(teY - tbY, teX - tbX) * 180 / Math.PI;
                features.tailAngle.push(Math.abs(angle));
                
                // 尻尾の動き（前フレームとの差）
                if (i > 0 && !isNaN(features.tailAngle[i-1])) {
                    const movement = Math.abs(features.tailAngle[i] - features.tailAngle[i-1]);
                    features.tailMovement.push(movement);
                } else {
                    features.tailMovement.push(0);
                }
            } else {
                features.tailAngle.push(NaN);
                features.tailMovement.push(0);
            }
            
            // 鼻と尻尾の距離
            if (nose && tailBase && this.isValidPoint(coords, likelihood, nose, i, confidence) &&
                this.isValidPoint(coords, likelihood, tailBase, i, confidence)) {
                
                const nX = coords[nose].x[i];
                const nY = coords[nose].y[i];
                const tbX = coords[tailBase].x[i];
                const tbY = coords[tailBase].y[i];
                
                const distance = Math.sqrt((nX - tbX) ** 2 + (nY - tbY) ** 2);
                features.noseTailDistance.push(distance);
            } else {
                features.noseTailDistance.push(NaN);
            }
            
            // 全体的な動き
            let totalMovement = 0;
            let validParts = 0;
            
            for (const part of data.bodyparts) {
                if (this.isValidPoint(coords, likelihood, part, i, confidence) && i > 0 &&
                    this.isValidPoint(coords, likelihood, part, i-1, confidence)) {
                    
                    const dx = coords[part].x[i] - coords[part].x[i-1];
                    const dy = coords[part].y[i] - coords[part].y[i-1];
                    totalMovement += Math.sqrt(dx * dx + dy * dy);
                    validParts++;
                }
            }
            
            features.overallMovement.push(validParts > 0 ? totalMovement / validParts : 0);
        }
        
        return features;
    }

    findBodypart(bodyparts, candidates) {
        for (const candidate of candidates) {
            const found = bodyparts.find(bp => 
                bp.toLowerCase().includes(candidate.toLowerCase())
            );
            if (found) return found;
        }
        return null;
    }

    isValidPoint(coords, likelihood, bodypart, frame, confidence) {
        if (!coords[bodypart] || !likelihood[bodypart]) return false;
        
        const x = coords[bodypart].x[frame];
        const y = coords[bodypart].y[frame];
        const like = likelihood[bodypart][frame];
        
        return !isNaN(x) && !isNaN(y) && like >= confidence;
    }

    extractWindowFeatures(features, start, end) {
        const window = {};
        
        for (const [key, values] of Object.entries(features)) {
            window[key] = values.slice(start, end);
        }
        
        return window;
    }

    calculatePlayfulnessMetrics(windowFeatures, fps) {
        // 尻尾の動きの活発さ
        const tailMovementMean = this.nanMean(windowFeatures.tailMovement);
        const tailMovementStd = this.nanStd(windowFeatures.tailMovement);
        
        // 尻尾の角度の変動
        const tailAngleStd = this.nanStd(windowFeatures.tailAngle);
        
        // 全体的な動きの活発さ
        const overallMovementMean = this.nanMean(windowFeatures.overallMovement);
        
        // 動きの周波性（簡易版）
        const movementFreq = this.estimateMovementFrequency(windowFeatures.tailMovement, fps);
        
        // スコア計算
        const activityScore = Math.min(1.0, tailMovementMean / 10.0);
        const variabilityScore = Math.min(1.0, tailAngleStd / 50.0);
        const frequencyScore = Math.min(1.0, movementFreq / 3.0);
        const mobilityScore = Math.min(1.0, overallMovementMean / 20.0);
        
        // 総合Playfulness指標
        const playIndex = (activityScore * 0.4 + variabilityScore * 0.3 + 
                          frequencyScore * 0.2 + mobilityScore * 0.1);
        
        return {
            tailAngle: this.nanMean(windowFeatures.tailAngle),
            tailMovement: tailMovementMean,
            tailVariability: tailAngleStd,
            overallMovement: overallMovementMean,
            movementFreq: movementFreq,
            playIndex: Math.max(0, Math.min(1, playIndex)),
            activityScore: activityScore,
            variabilityScore: variabilityScore,
            frequencyScore: frequencyScore,
            mobilityScore: mobilityScore
        };
    }

    estimateMovementFrequency(movements, fps) {
        const validMovements = movements.filter(m => !isNaN(m) && m > 0);
        if (validMovements.length < 4) return 0;
        
        // 閾値を超える動きの頻度
        const threshold = this.nanMean(validMovements);
        let peaks = 0;
        
        for (let i = 1; i < validMovements.length - 1; i++) {
            if (validMovements[i] > threshold && 
                validMovements[i] > validMovements[i-1] && 
                validMovements[i] > validMovements[i+1]) {
                peaks++;
            }
        }
        
        return (peaks / validMovements.length) * fps;
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
        if (this.debugMode) {
            console.log(`[CSVAnalyzer] ${message}`);
            const debugEl = document.getElementById('debugInfo');
            if (debugEl) {
                debugEl.innerHTML += `<div>${message}</div>`;
                debugEl.scrollTop = debugEl.scrollHeight;
            }
        }
    }

    updateProgress(percent, message) {
        document.getElementById('progressFill').style.width = percent + '%';
        document.getElementById('progressText').textContent = message;
        
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
