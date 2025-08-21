class MultiHeaderCSVAnalyzer {
    constructor() {
        this.csvData = null;
        this.debugMode = true;
        this.structure = null;
        this.eps = 1e-9;
        
        // グローバルアクセス用
        window.lastAnalyzer = this;
    }

    /* ===================== public ===================== */

    async analyze(csvFile, videoFile, settings) {
        this.updateProgress(0, 'CSVファイル読み込み中...');
        
        try {
            const rawLines = await this.readCSVLines(csvFile);
            this.updateProgress(20, '多層ヘッダー解析中...');

            const parsedData = await this.parseMultiHeaderCSV(rawLines);
            this.updateProgress(40, '身体部位座標抽出中...');

            const coordinates = await this.extractCoordinatesFromParsedData(parsedData);
            this.updateProgress(60, 'Playfulness指標計算中...');

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
            await new Promise(r => setTimeout(r, 200));
            return results;

        } catch (e) {
            this.log(`エラー: ${e.message}`);
            throw e;
        }
    }

    /* ===================== IO ===================== */

    async readCSVLines(file) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = e => {
                try {
                    const text = e.target.result;
                    const lines = text.split(/\r?\n/);
                    this.log(`CSV読み込み完了: ${lines.length}行`);
                    resolve(lines);
                } catch (err) { 
                    reject(err); 
                }
            };
            fr.onerror = () => reject(new Error('ファイル読み込みエラー'));
            fr.readAsText(file);
        });
    }

    safeSplit(line) {
        const out = [];
        let cur = '', inQ = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') inQ = !inQ;
            else if (ch === ',' && !inQ) { 
                out.push(cur); 
                cur = ''; 
            }
            else cur += ch;
        }
        out.push(cur);
        return out.map(s => s.trim().replace(/^"|"$/g, ''));
    }

    /* ===================== parser ===================== */

    async parseMultiHeaderCSV(lines) {
        // 先頭最大6行を候補として見る
        const head = [];
        for (let i = 0; i < Math.min(6, lines.length); i++) {
            head.push(this.safeSplit(lines[i]));
        }

        // coords 行の推定（ユニーク値が {x,y,likelihood} のみ）
        let coordRowIdx = -1;
        for (let r = 1; r < head.length; r++) {
            const uniq = new Set(head[r].map(s => s.toLowerCase()));
            const ok = [...uniq].every(v => v === '' || v === 'x' || v === 'y' || v === 'likelihood');
            if (ok) { 
                coordRowIdx = r; 
                break; 
            }
        }
        
        if (coordRowIdx === -1) {
            throw new Error('coordsヘッダ行（x,y,likelihood）が見つかりません');
        }

        const headerRows = head.slice(0, coordRowIdx + 1);
        const dataStart = coordRowIdx + 1;

        let scorerRow, individualRow = null, bodypartRow, coordRow;
        
        if (headerRows.length === 3) {
            [scorerRow, bodypartRow, coordRow] = headerRows;
        } else if (headerRows.length === 4) {
            [scorerRow, individualRow, bodypartRow, coordRow] = headerRows;
        } else {
            // 非典型：最初と最後を強引に割当
            scorerRow = headerRows[0];
            coordRow = headerRows.at(-1);
            bodypartRow = headerRows.length >= 3 ? headerRows.at(-2) : headerRows[0].map(() => '');
        }

        const hdrLen = Math.max(
            scorerRow.length, 
            bodypartRow.length, 
            coordRow.length, 
            individualRow?.length || 0
        );
        
        const scorer = this.padToLen(scorerRow, hdrLen);
        const individual = this.padToLen(individualRow || [], hdrLen);
        const bodypart = this.padToLen(bodypartRow, hdrLen);
        const coord = this.padToLen(coordRow, hdrLen);

        // メタ保存
        const dataLines = lines.slice(dataStart).filter(Boolean);
        this.structure = {
            scorer: [...new Set(scorer.filter(Boolean))][0] || scorer[0] || '',
            individuals: [...new Set(individual.filter(Boolean))],
            bodyparts: [...new Set(bodypart.filter(Boolean))],
            totalColumns: hdrLen,
            headerRows: headerRows.length
        };

        this.log(`ヘッダ行: ${headerRows.length}段 / カラム数=${hdrLen}`);
        this.log(`スコアラー: ${this.structure.scorer}`);
        this.log(`個体: ${this.structure.individuals.join(', ') || '(なし)'}`);
        this.log(`身体部位数: ${this.structure.bodyparts.length}`);
        this.log(`身体部位一覧: ${this.structure.bodyparts.join(', ')}`);

        return {
            numFrames: dataLines.length,
            individuals: this.structure.individuals,
            bodyparts: this.structure.bodyparts,
            headers: { scorer, individual, bodypart, coord },
            dataLines
        };
    }

    padToLen(arr, L) { 
        const a = arr.slice(); 
        while (a.length < L) a.push(''); 
        return a; 
    }

    /* ===================== coordinate extraction ===================== */

    async extractCoordinatesFromParsedData(parsed) {
        this.log('座標データを抽出中...');

        const { headers, dataLines } = parsed;
        const N = dataLines.length;

        // 各列のフィールド（individual/bodypart/coord）をまとめる
        const cols = [];
        for (let i = 0; i < headers.bodypart.length; i++) {
            cols.push({
                idx: i,
                individual: (headers.individual?.[i] || '').trim(),
                bodypart: (headers.bodypart?.[i] || '').trim(),
                coord: (headers.coord?.[i] || '').trim().toLowerCase()
            });
        }

        // 体部位→coord→列idx の辞書を作る（重複は最初を採用）
        const byPart = new Map();
        for (const c of cols) {
            if (!c.bodypart || !['x', 'y', 'likelihood'].includes(c.coord)) continue;
            const bp = c.bodypart;
            if (!byPart.has(bp)) byPart.set(bp, {});
            if (byPart.get(bp)[c.coord] == null) byPart.get(bp)[c.coord] = c.idx;
        }

        // すべてのbodypartについて配列準備
        const coordinates = {};
        const likelihood = {};
        const bpList = [...byPart.keys()];
        
        for (const bp of bpList) {
            coordinates[bp] = { x: new Array(N).fill(NaN), y: new Array(N).fill(NaN) };
            likelihood[bp] = new Array(N).fill(0);
        }

        // データ読み込み
        for (let r = 0; r < N; r++) {
            const vals = this.safeSplit(dataLines[r]);
            for (const bp of bpList) {
                const idxX = byPart.get(bp)?.x;
                const idxY = byPart.get(bp)?.y;
                const idxL = byPart.get(bp)?.likelihood;
                
                if (idxX != null) { 
                    const v = parseFloat(vals[idxX]); 
                    if (!Number.isNaN(v)) coordinates[bp].x[r] = v; 
                }
                if (idxY != null) { 
                    const v = parseFloat(vals[idxY]); 
                    if (!Number.isNaN(v)) coordinates[bp].y[r] = v; 
                }
                if (idxL != null) { 
                    const v = parseFloat(vals[idxL]); 
                    if (!Number.isNaN(v)) likelihood[bp][r] = v; 
                    else likelihood[bp][r] = 0; 
                }
                else { 
                    likelihood[bp][r] = 1.0; // likelihood列が無い場合は既定1
                }
            }
            
            if (r % 200 === 0) {
                const p = 40 + (r / N) * 20;
                this.updateProgress(p, `座標抽出中: ${r}/${N}`);
                await new Promise(res => setTimeout(res, 0));
            }
        }

        coordinates._likelihood = likelihood;
        coordinates._metadata = {
            numFrames: N,
            bodyparts: bpList,
            individuals: parsed.individuals
        };
        
        return coordinates;
    }

    /* ===================== playfulness ===================== */

    async performPlayfulnessAnalysis(coordinates, settings) {
        const { fps = 30, windowSec = 2.0, confidence = 0.5 } = settings || {};
        const win = Math.max(8, Math.round(windowSec * fps));
        const hop = Math.max(1, Math.round(0.5 * fps)); // 0.5秒ステップ

        const numFrames = coordinates._metadata.numFrames;
        const bodyparts = coordinates._metadata.bodyparts;

        // === 体部位マッピング（ゆれ吸収：正規表現） ===
        const map = this.mapRequiredBodypartsWithRegex(bodyparts);
        this.log(`身体部位マッピング結果:`);
        for (const [key, value] of Object.entries(map)) {
            this.log(`  ${key}: ${value || '❌見つからず'}`);
        }

        // === フレーム特徴量 ===
        const feat = await this.calculateFrameFeaturesV2(coordinates, map, confidence, fps);

        // === 姿勢・移動シグナル推定 ===
        const posture = this.estimatePostureSignals(coordinates, map, fps, confidence);

        // === ウィンドウ集約 ===
        // グローバル標準偏差を事前計算（activityScore正規化用）
        const globalAngVelStd = this.std(feat.angVelAll);
        
        const metrics = [];
        for (let startIdx = 0; startIdx + win <= numFrames; startIdx += hop) {
            const endIdx = startIdx + win;
            const seg = (arr) => arr.slice(startIdx, endIdx);

            // ====== 1) 姿勢・移動のウィンドウ統計 ======
            const movingRatio = seg(posture.moving).reduce((s,v)=>s+(v?1:0),0) / win;
            const spineStraightAvg = this.mean(seg(posture.straight));

            // 起立・移動文脈か？
            const isActive = (movingRatio > 0.35) || (spineStraightAvg > 0.65);
            
            // ====== 2) 既存特徴量のウィンドウ統計 ======
            const tailAngle = seg(feat.tailAngle);
            const tailBend = seg(feat.tailBend);
            const earForward = seg(feat.earForward);
            const angVel = seg(feat.angVel);
            const noseSpeed = seg(feat.noseSpeed);
            // ADD:
            const earForwardScoreSeg = seg(feat.earForwardScoreFrame);
            const airplaneSeg = seg(feat.airplaneIdx);

            // 周波数解析
            const wag = this.dominantFreqHz(seg(feat.tailAngleInterp), fps);
            const wagFreq = wag.f || 0;
            const wagPower = wag.p || 0;
            
            // lashing（バシバシ）検出
            const lashPow = this.bandPowerDFT(seg(feat.tailAngleInterp), fps, 0.3, 1.2);
            const totalPow = this.bandPowerDFT(seg(feat.tailAngleInterp), fps, 0.3, 12);
            const amp = this.percentile(tailAngle.filter(Number.isFinite), 90) - 
                       this.percentile(tailAngle.filter(Number.isFinite), 10);
            // 10〜60°を0〜1に写像（初期値。後でデータに合わせて微調整）
            const ampNorm = this.clamp01((amp - 10) / 50);
            const lashingPenalty = this.clamp01((lashPow / (totalPow + 1e-9)) * ampNorm);

            // 特徴量統計
            const tailAngleMean = this.mean(tailAngle);
            const tailBendMean = this.mean(tailBend);
            const earForwardMean = this.mean(earForward);
            const angVelStd = this.std(angVel);
            const noseMovementMean = this.mean(noseSpeed);
            // ADD: スコア平均（0〜1）
            const earForwardScoreMean = this.mean(earForwardScoreSeg);
            const airplaneMean = this.mean(airplaneSeg);
            
            // 条件付きagitationPenalty（ネガ徴候時のみ減点）
            const torsoSpeed = noseMovementMean; // 胴体基準速度の代替として鼻速度を使用
            const zSpeed = this.robustZ(torsoSpeed, feat.noseSpeed);
            const alpha = 1.0, beta = 0.6, tau1 = 0.4, tau2 = 1.0; // 推奨初期値
            const conditionalAgitation = this.sigmoid(alpha * (lashingPenalty + airplaneMean - tau1) + beta * Math.max(0, zSpeed - tau2));

            // 0–1正規化（パーセンタイル）
            const nz = v => v.filter(Number.isFinite);
            const pScale = (arr, lo = 5, hi = 95) => {
                const v = nz(arr).sort((x, y) => x - y);
                const q = p => v.length ? v[Math.min(v.length - 1, Math.max(0, Math.floor(p / 100 * (v.length - 1))))] : 0;
                const ql = q(lo), qh = q(hi);
                return arr.map(x => !Number.isFinite(x) ? 0 : (qh > ql ? Math.min(1, Math.max(0, (x - ql) / (qh - ql))) : 0));
            };

            const tailUpScore = this.mean(this.inverseArr(pScale(tailAngle)));     // 角が小さい＝上向き（胴体基準）
            const earForwardScore = earForwardScoreMean; // 0〜1（既に正規化済み、頭基準）
            const tailBendScore = this.mean(pScale(tailBend));                     // 大きい＝曲げ大
            const airplanePenalty = airplaneMean;        // イカ耳ペナルティ
            const agitationPenalty = conditionalAgitation; // 条件付きagitation

            // 周波数スコア（帯域ベース、固定4Hz廃止）
            const playBandPow = this.bandPowerDFT(seg(feat.tailAngleInterp), fps, 2, 6);
            const totalSpecPow = this.bandPowerDFT(seg(feat.tailAngleInterp), fps, 0.3, 12);
            const wagScore = this.clamp01(playBandPow / (totalSpecPow + 1e-9));

            // ====== 3) 休息時限定の tip twitch（先端ピクピク）を加点 ======
            let tipTwitchScore = 0;
            if (!isActive) {
                const tb = map.tail_base, te = map.tail_end;
                if (tb && te) {
                    const rx=[], ry=[];
                    for(let i=startIdx;i<endIdx;i++){
                        const x = (coordinates[te].x[i]-coordinates[tb].x[i]);
                        const y = (coordinates[te].y[i]-coordinates[tb].y[i]);
                        rx.push(x); ry.push(y);
                    }
                    // 相対先端角
                    const tipAng = rx.map((x,i)=> Math.atan2(ry[i],x)*180/Math.PI);
                    const tipPow = this.bandPowerDFT(tipAng, fps, 5.0, 10.0);
                    const tipTot = this.bandPowerDFT(tipAng, fps, 1.0, 12.0) + 1e-9;
                    const smallAmp = this.clamp01((25 - amp)/25); // 振幅が小さいほど1
                    tipTwitchScore = this.clamp01((tipPow/tipTot) * smallAmp);
                }
            }

            // ====== 4) 改善版重み付け（姿勢連動） ======
            const activityScore = Number.isFinite(angVelStd) ? Math.min(1, angVelStd / (this.eps + globalAngVelStd)) : 0;
            
            // 重み連動（姿勢で切替）
            const W = isActive
                ? { tail:0.28, ears:0.24, bend:0.18, wag:0.18, act:0.12, penAir:0.10, penLash:0.12, penAg:0.08, tip:0.00 }
                : { tail:0.08, ears:0.24, bend:0.18, wag:0.12, act:0.06, penAir:0.10, penLash:0.15, penAg:0.08, tip:0.06 };

            // === Negative override START ===
            // 1) その窓の耳トラッキング信頼度（likelihood平均）を計算
            const earConfMean = (() => {
                const L = coordinates._likelihood;
                const parts = [map.left_ear_base, map.left_ear_end, map.right_ear_base, map.right_ear_end]
                            .filter(Boolean);
                if (!parts.length) return 0;
                let s = 0, c = 0;
                for (let i = startIdx; i < endIdx; i++) {
                    for (const p of parts) { const v = L[p]?.[i]; if (Number.isFinite(v)) { s += v; c++; } }
                }
                return c ? s / c : 0;
            })();

            // 2) ネガティブ文脈の強さ（イカ耳 vs ラッシング）
            const negCue = Math.max(airplanePenalty, lashingPenalty);

            // 3) 耳が十分に見えている窓では、ネガティブが強いほど「尻尾の加点重み」を抑える
            //    （maskは negCue=0.35付近から効き始め、0.8超で強く抑制）
            if (earConfMean >= Math.max(0.45, confidence - 0.05)) {
                const mask = 1 - this.clamp01(1.8 * (negCue - 0.35));
                W.tail *= mask;   // 尻尾上がりの重みを抑制
                W.wag  *= mask;   // 尻尾振りの重みを抑制
            }
            // === Negative override END ===

            // --- ここから追記（NaN無毒化） ---
            const S = {
                tail: this.safe0(tailUpScore),
                ears: this.safe0(earForwardScore),
                bend: this.safe0(tailBendScore),
                wag : this.safe0(wagScore),
                act : this.safe0(activityScore),
                tip : this.safe0(tipTwitchScore)
            };
            const P = {
                air : this.safe0(airplanePenalty),
                lash: this.safe0(lashingPenalty),
                ag  : this.safe0(conditionalAgitation)
            };
            // 4) 減点キャップの解除条件（イカ耳/ラッシングが明確）
            let penaltySum = (W.penAir*P.air + W.penLash*P.lash + W.penAg*P.ag);
            let penaltyCap = 0.8 * this.safe0(
                W.tail*S.tail + W.ears*S.ears + W.bend*S.bend + W.wag*S.wag + W.act*S.act + W.tip*S.tip
            );
            // 強いネガ（≥0.6）かつ耳が見えているときはキャップ解除（しっかり下がる）
            if (negCue >= 0.60 && earConfMean >= Math.max(0.45, confidence - 0.05)) {
                penaltyCap = Infinity;
            }
            penaltySum = Math.min(penaltySum, penaltyCap);
            // --- ここまで追記 ---

            // 置き換え：playfulness の計算
            let playfulness = (
                W.tail*S.tail + W.ears*S.ears + W.bend*S.bend + W.wag*S.wag + W.act*S.act + W.tip*S.tip
            ) - penaltySum;
            
            const base = this.clamp01(playfulness);
            const playIndexSafe = Number.isFinite(base) ? base : 0;

            metrics.push({
                timeCenter: (startIdx + endIdx) / (2 * fps),
                playIndex : playIndexSafe,
                // （以下は従来どおり）
                tailAngleMean, tailBendMean, earForwardMean, wagFreqHz: wagFreq, wagPower,
                angVelStd, noseMovement: noseMovementMean,
                tailUpScore: S.tail, earForwardScore: S.ears, tailBendScore: S.bend,
                wagScore: S.wag, activityScore: S.act,
                airplanePenalty: P.air, lashingPenalty: P.lash, agitationPenalty: P.ag,
                airplaneMean: airplaneMean,          // ← 追加
                conditionalAgitation: conditionalAgitation, // ← 追加
                tipTwitchScore: tipTwitchScore,      // ← 新規追加

                // 📈 姿勢情報（新規追加）
                movingRatio: movingRatio,
                spineStraightness: spineStraightAvg,
                postureState: isActive ? 'active' : 'rest',

                rawTailAngles: tailAngle.filter(v => Number.isFinite(v)),
                rawEarAngles : earForward.filter(v => Number.isFinite(v)),
                rawAngVel    : angVel.filter(v => Number.isFinite(v))
            });

            // 進捗更新
            const progress = 60 + ((startIdx / numFrames) * 20);
            this.updateProgress(progress, `解析中: ${Math.round((startIdx / numFrames) * 100)}%`);
            
            if (startIdx % (hop * 10) === 0) {
                await new Promise(resolve => setTimeout(resolve, 1));
            }
        }

        this.log(`解析完了: ${metrics.length}個のデータポイント`);
        
        // 結果統計を表示
        if (metrics.length > 0) {
            const playIndices = metrics.map(m => m.playIndex);
            const min = Math.min(...playIndices);
            const max = Math.max(...playIndices);
            const mean = playIndices.reduce((a, b) => a + b) / playIndices.length;
            
            this.log(`Playfulness統計: min=${min.toFixed(3)}, max=${max.toFixed(3)}, mean=${mean.toFixed(3)}`);
            this.log(`変動あり: ${min !== max ? '✅' : '❌'}`);
        }
        
        return metrics;
    }

    mapRequiredBodypartsWithRegex(bodyparts) {
        // 代表名 → 正規表現（大小区別なし）
        const RX = {
            tail_base: /(tail[_\s-]?(base|root)|base[_\s-]?tail|tail0|tail_?0)/i,
            tail_end: /(tail[_\s-]?(tip|end)|tail\d+$|tail_?[1-9]|tailtip)/i,
            nose: /(nose|snout|muzzle)/i,
            neck_base: /(neck(_?base)?|withers|shoulder(_?center)?)/i,
            back_end: /(back[_\s-]?(end|base)|hip|pelvis|rump|sacrum|spine4)/i,
            back_middle: /(back[_\s-]?(mid|middle)|spine2|spine3|thorax|midback)/i,
            left_ear_base: /(left.*ear.*(base)?|ear.*left.*(base)?)/i,
            left_ear_end: /(left.*ear.*(tip|end)|ear.*left.*(tip|end))/i,
            right_ear_base: /(right.*ear.*(base)?|ear.*right.*(base)?)/i,
            right_ear_end: /(right.*ear.*(tip|end)|ear.*right.*(tip|end))/i
        };
        
        const norm = s => String(s || '');
        const pick = rx => bodyparts.find(bp => rx.test(norm(bp))) || null;
        const out = {};
        
        for (const k of Object.keys(RX)) {
            out[k] = pick(RX[k]);
        }
        
        return out;
    }

    async calculateFrameFeaturesV2(coor, map, pcut, fps) {
        const N = coor._metadata.numFrames;
        const L = coor._likelihood;
        const val = (bp, c, i) => (bp && coor[bp] ? coor[bp][c][i] : NaN);
        const likeOK = (bp, i) => (bp && L[bp] ? (L[bp][i] ?? 1) >= pcut : false);

        const tailAngle = new Array(N).fill(NaN);
        const tailBend = new Array(N).fill(NaN);
        const earForward = new Array(N).fill(NaN);
        const noseSpeed = new Array(N).fill(0);

        this.log('フレーム特徴量計算開始...');

        for (let i = 0; i < N; i++) {
            // しっぽ角（胴体基準での相対角度）
            if (likeOK(map.tail_base, i) && likeOK(map.tail_end, i) && 
                (likeOK(map.back_middle, i) || likeOK(map.back_end, i))) {
                const bx = likeOK(map.back_middle, i) ? val(map.back_middle, 'x', i) : val(map.back_end, 'x', i);
                const by = likeOK(map.back_middle, i) ? val(map.back_middle, 'y', i) : val(map.back_end, 'y', i);
                const tx = val(map.tail_base, 'x', i), ty = val(map.tail_base, 'y', i);
                const ex = val(map.tail_end, 'x', i), ey = val(map.tail_end, 'y', i);
                
                const ax = tx - bx, ay = ty - by;       // 胴体軸
                const vx = ex - tx, vy = ey - ty;       // 尾ベクトル
                tailAngle[i] = this.angleDeg(ax, ay, vx, vy);  // 0°=胴体軸と一致＝上げ
            }

            // しっぽ曲げ角： back_end → tail_base → tail_end の外角
            if (likeOK(map.back_end, i) && likeOK(map.tail_base, i) && likeOK(map.tail_end, i)) {
                const bx = val(map.back_end, 'x', i), by = val(map.back_end, 'y', i);
                const tx = val(map.tail_base, 'x', i), ty = val(map.tail_base, 'y', i);
                const ex = val(map.tail_end, 'x', i), ey = val(map.tail_end, 'y', i);
                tailBend[i] = this.angleAt(bx, by, tx, ty, ex, ey);
            }

            // === 耳の前向き度（REPLACE: 旧ロジックをこのブロックに差し替え） ===
            if (likeOK(map.nose, i) && (likeOK(map.neck_base, i) || likeOK(map.back_middle, i))) {
                // 頭の前方軸 F と側方軸 L を作る（nose 方向を前）
                const kx = likeOK(map.neck_base, i) ? val(map.neck_base, 'x', i) : val(map.back_middle, 'x', i);
                const ky = likeOK(map.neck_base, i) ? val(map.neck_base, 'y', i) : val(map.back_middle, 'y', i);
                const nx = val(map.nose, 'x', i), ny = val(map.nose, 'y', i);
                let [Fx, Fy] = this.norm2(nx - kx, ny - ky);
                if (Number.isFinite(Fx)) {
                    let [Lx, Ly] = this.rot90(Fx, Fy); // 側方軸
                    const Lset = [['left_ear_base', 'left_ear_end'], ['right_ear_base', 'right_ear_end']];
                    const perEar = [];

                    for (const [eb, ee] of Lset) {
                        if (!likeOK(map[eb], i)) continue;

                        // 耳ベクトル v：tip が無ければ nose を代替
                        let vx, vy;
                        if (likeOK(map[ee], i)) {
                            vx = val(map[ee], 'x', i) - val(map[eb], 'x', i);
                            vy = val(map[ee], 'y', i) - val(map[eb], 'y', i);
                        } else {
                            vx = nx - val(map[eb], 'x', i);
                            vy = ny - val(map[eb], 'y', i);
                        }
                        const vn = Math.hypot(vx, vy);
                        if (!vn) continue;
                        vx /= vn; vy /= vn;

                        // 前方成分 f と側方成分 l
                        const f = vx*Fx + vy*Fy;           // [-1,1] 前（+）/ 後（-）
                        const l = Math.abs(vx*Lx + vy*Ly); // [0,1] 側方の強さ

                        // 表示用角度（旧API互換）：頭前方軸 vs 耳ベクトル
                        const angle = this.vecAngleDeg(Fx, Fy, vx, vy); // 小さいほど前向き

                        // 新しい前向きスコア：前方成分が大・側方成分が小で高得点
                        //   forwardness ≈ 1  … f≫0 & l≪0   （素直に前）
                        //   forwardness ≈ 0  … f≤0 or l≫0   （後ろ/横＝イカ耳）
                        const forwardness = this.clamp01( 0.5*(f - l) + 0.5 );

                        // イカ耳らしさ（側方が大きく、かつ前方が弱い/負）
                        const airplane = (l > 0.6 && forwardness < 0.4) ? 1 : 0;

                        perEar.push({ angle, forwardness, airplane });
                    }

                    if (perEar.length) {
                        // 角度系列（可視化・統計用）は従来通り保持
                        earForward[i] = perEar.reduce((s,e)=>s+e.angle,0)/perEar.length;

                        // 追加：フレーム毎の耳前向きスコア＆イカ耳指標を保持（後段で利用）
                        if (!this._earForwardScoreFrame) this._earForwardScoreFrame = new Array(N).fill(NaN);
                        if (!this._airplaneIdx) this._airplaneIdx = new Array(N).fill(0);
                        this._earForwardScoreFrame[i] = perEar.reduce((s,e)=>s+e.forwardness,0)/perEar.length;
                        this._airplaneIdx[i]          = perEar.reduce((s,e)=>s+e.airplane,0)/perEar.length;
                    }
                }
            }

            // 鼻スピード（活動度の粗指標）
            if (i > 0 && likeOK(map.nose, i) && likeOK(map.nose, i - 1)) {
                const dx = val(map.nose, 'x', i) - val(map.nose, 'x', i - 1);
                const dy = val(map.nose, 'y', i) - val(map.nose, 'y', i - 1);
                noseSpeed[i] = Math.hypot(dx, dy);
            }

            // 進捗更新
            if (i % 100 === 0) {
                const progress = 60 + ((i / N) * 5);
                this.updateProgress(progress, `特徴量計算: ${i}/${N}`);
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        // 角速度
        const tailAngleInterp = this.interpNaN(tailAngle);
        const angVel = tailAngleInterp.map((v, i, arr) => i ? Math.abs(v - arr[i - 1]) * fps : 0);

        // 統計出力
        this.log('=== 特徴量統計 ===');
        const features = { tailAngle, tailBend, earForward, noseSpeed, angVel };
        for (const [name, values] of Object.entries(features)) {
            const valid = values.filter(Number.isFinite);
            if (valid.length > 0) {
                const min = Math.min(...valid);
                const max = Math.max(...valid);
                const mean = valid.reduce((a, b) => a + b) / valid.length;
                this.log(`${name}: 有効=${valid.length}/${values.length}, 範囲=${min.toFixed(2)}-${max.toFixed(2)}, 平均=${mean.toFixed(2)}`);
            } else {
                this.log(`${name}: 有効データなし`);
            }
        }

        return { 
            tailAngle, tailAngleInterp, tailBend, earForward, angVel, angVelAll: angVel.slice(), noseSpeed,
            // ADD:
            earForwardScoreFrame: this._earForwardScoreFrame || new Array(N).fill(NaN),
            airplaneIdx: this._airplaneIdx || new Array(N).fill(0)
        };
    }

    /* ===================== math helpers ===================== */

    // === helpers (ADD) ===
    clamp01(x){
        // NaNや±Infinityを0に丸めた上で0..1にクリップ
        x = Number.isFinite(x) ? x : 0;
        if (x < 0) return 0;
        if (x > 1) return 1;
        return x;
    }

    // 合成前に各項目を無毒化するヘルパ
    safe0(x){ 
        return Number.isFinite(x) ? x : 0; 
    }
    
    norm2(ax, ay) { 
        const n = Math.hypot(ax, ay); 
        return n ? [ax/n, ay/n] : [NaN, NaN]; 
    }
    
    rot90(ax, ay) { 
        return [-ay, ax]; // 90°回転（左向き）
    }

    mean(a) { 
        const v = a.filter(Number.isFinite); 
        return v.length ? v.reduce((p, c) => p + c, 0) / v.length : 0; 
    }
    
    std(a) { 
        const v = a.filter(Number.isFinite); 
        if (v.length <= 1) return 0; 
        const m = this.mean(v); 
        return Math.sqrt(v.reduce((p, c) => p + (c - m) * (c - m), 0) / v.length); 
    }
    
    inverseArr(a) { 
        return a.map(v => 1 - (Number.isFinite(v) ? v : 0)); 
    }

    angleDeg(ax, ay, bx, by) { 
        // 2Dベクトルa,bの角度
        const a = Math.hypot(ax, ay), b = Math.hypot(bx, by);
        if (!a || !b) return NaN;
        const cos = ((ax * bx) + (ay * by)) / (a * b);
        return Math.acos(Math.min(1, Math.max(-1, cos))) * 180 / Math.PI;
    }
    
    vecAngleDeg(ax, ay, bx, by) { 
        return this.angleDeg(ax, ay, bx, by); 
    }
    
    angleAt(ax, ay, bx, by, cx, cy) { 
        // ∠ABC
        return this.vecAngleDeg(ax - bx, ay - by, cx - bx, cy - by);
    }
    
    interpNaN(arr) {
        const a = arr.slice();
        // 前方補間
        let last = null; 
        for (let i = 0; i < a.length; i++) { 
            if (Number.isFinite(a[i])) last = a[i]; 
            else if (last != null) a[i] = last; 
        }
        // 後方補間
        let next = null; 
        for (let i = a.length - 1; i >= 0; i--) { 
            if (Number.isFinite(a[i])) next = a[i]; 
            else if (next != null) a[i] = next; 
        }
        // 残りは0
        for (let i = 0; i < a.length; i++) {
            if (!Number.isFinite(a[i])) a[i] = 0;
        }
        return a;
    }
    
    dominantFreqHz(series, fps) {
        const x = this.interpNaN(series);
        const n = x.length;
        if (n < 8 || fps <= 0) return { f: NaN, p: NaN };
        
        // DC除去
        const m = this.mean(x); 
        for (let i = 0; i < n; i++) x[i] -= m;
        
        // 簡易DFT（最大ピーク）
        let bestF = NaN, bestP = -1;
        for (let k = 1; k <= Math.floor(n / 2); k++) {
            const f = k * fps / n;
            let re = 0, im = 0;
            for (let t = 0; t < n; t++) {
                const ang = -2 * Math.PI * k * t / n;
                re += x[t] * Math.cos(ang); 
                im += x[t] * Math.sin(ang);
            }
            const p = re * re + im * im;
            if (p > bestP) { 
                bestP = p; 
                bestF = f; 
            }
        }
        return { f: bestF, p: bestP };
    }
    
    // 帯域パワー計算（簡易DFT版）
    bandPowerDFT(series, fps, f1, f2) {
        const x = this.interpNaN(series);
        const n = x.length;
        if (n < 8 || fps <= 0) return 0;
        
        // DC除去
        const m = this.mean(x); 
        for (let i = 0; i < n; i++) x[i] -= m;
        
        let totalPower = 0;
        for (let k = 1; k <= Math.floor(n / 2); k++) {
            const f = k * fps / n;
            if (f >= f1 && f <= f2) {
                let re = 0, im = 0;
                for (let t = 0; t < n; t++) {
                    const ang = -2 * Math.PI * k * t / n;
                    re += x[t] * Math.cos(ang); 
                    im += x[t] * Math.sin(ang);
                }
                totalPower += re * re + im * im;
            }
        }
        return totalPower;
    }
    
    // ロバストZスコア（中央値ベース）
    robustZ(value, array) {
        const valid = array.filter(Number.isFinite);
        if (valid.length < 3) return 0;
        
        valid.sort((a, b) => a - b);
        const median = valid[Math.floor(valid.length / 2)];
        const mad = this.mean(valid.map(v => Math.abs(v - median)));
        
        return mad > 0 ? (value - median) / (1.4826 * mad) : 0;
    }
    
    // パーセンタイル計算
    percentile(array, p) {
        const sorted = array.filter(Number.isFinite).sort((a, b) => a - b);
        if (sorted.length === 0) return 0;
        const index = (p / 100) * (sorted.length - 1);
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        if (lower === upper) return sorted[lower];
        return sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
    }
    
    // シグモイド関数
    sigmoid(x) {
        return 1 / (1 + Math.exp(-x));
    }

    /* ===================== logging/UI ===================== */

    log(msg) {
        console.log(`[MultiHeaderCSV] ${msg}`);
        const box = document.getElementById('debugInfo');
        if (box) { 
            box.innerHTML += `<div>${msg}</div>`; 
            box.scrollTop = box.scrollHeight; 
        }
    }
    
    updateProgress(percent, message) {
        const fill = document.getElementById('progressFill');
        const text = document.getElementById('progressText');
        if (fill) fill.style.width = percent + '%';
        if (text) text.textContent = message;
        
        const steps = ['step1', 'step2', 'step3', 'step4'];
        const cur = Math.floor(percent / 25);
        steps.forEach((id, idx) => { 
            const el = document.getElementById(id); 
            if (el && idx <= cur) el.classList.add('completed'); 
        });
    }
    
    /* ===================== feature display ===================== */
    
    updateFeatureDisplay(currentMetric) {
        if (!currentMetric) return;
        
        // 各特徴量の値と正規化された値を取得
        const features = {
            tailUp: {
                raw: currentMetric.tailAngleMean,
                score: currentMetric.tailUpScore,
                unit: '°',
                description: `角度: ${(currentMetric.tailAngleMean || 0).toFixed(1)}°`
            },
            earForward: {
                raw: currentMetric.earForwardMean,
                score: currentMetric.earForwardScore,
                unit: '°',
                description: `角度: ${(currentMetric.earForwardMean || 0).toFixed(1)}°`
            },
            tailBend: {
                raw: currentMetric.tailBendMean,
                score: currentMetric.tailBendScore,
                unit: '°',
                description: `角度: ${(currentMetric.tailBendMean || 0).toFixed(1)}°`
            },
            wagFreq: {
                raw: currentMetric.wagFreqHz,
                score: currentMetric.wagScore,
                unit: 'Hz',
                description: `周波数: ${(currentMetric.wagFreqHz || 0).toFixed(2)}Hz`
            },
            angVel: {
                raw: currentMetric.angVelStd,
                score: currentMetric.activityScore,
                unit: '°/s',
                description: `変動: ${(currentMetric.angVelStd || 0).toFixed(1)}°/s`
            },
            airplane: {
                raw: currentMetric.airplaneMean || 0,
                score: currentMetric.airplanePenalty || 0,
                unit: '',
                description: `イカ耳率: ${((currentMetric.airplaneMean || 0) * 100).toFixed(1)}%`
            },
            lashing: {
                raw: currentMetric.lashingPenalty || 0,
                score: currentMetric.lashingPenalty || 0,
                unit: '',
                description: `バシバシ強度: ${(currentMetric.lashingPenalty || 0).toFixed(3)}`
            },
            agitation: {
                raw: currentMetric.conditionalAgitation || 0,
                score: currentMetric.conditionalAgitation || 0,
                unit: '',
                description: `過活動度: ${(currentMetric.conditionalAgitation || 0).toFixed(3)}`
            }
        };
        
        // DOM要素を更新
        this.updateFeatureCard('tailUp', features.tailUp, '尻尾上がり度');
        this.updateFeatureCard('earForward', features.earForward, '耳前向き度');
        this.updateFeatureCard('tailBend', features.tailBend, '尻尾曲げ度');
        this.updateFeatureCard('wagFreq', features.wagFreq, '振り周波数');
        this.updateFeatureCard('angVel', features.angVel, '角速度運動');
        this.updateFeatureCard('airplane', features.airplane, 'イカ耳ペナルティ');
        this.updateFeatureCard('lashing', features.lashing, 'バシバシペナルティ');
        this.updateFeatureCard('agitation', features.agitation, '条件付き過活動ペナルティ');
        
        // 総合スコア
        const totalScore = currentMetric.playIndex;
        this.updateFeatureCard('totalPlay', {
            raw: totalScore,
            score: totalScore,
            unit: '',
            description: `総合指標: ${totalScore.toFixed(3)}`
        }, 'Playfulness');
    }
    
    updateFeatureCard(prefix, feature, label) {
        const valueEl = document.getElementById(`${prefix}Value`);
        const meterEl = document.getElementById(`${prefix}Meter`);
        
        if (valueEl) {
            if (feature.unit === '') {
                valueEl.textContent = (feature.score || 0).toFixed(3);
            } else {
                valueEl.textContent = `${(feature.raw || 0).toFixed(2)}${feature.unit}`;
            }
        }
        
        if (meterEl) {
            const percentage = Math.max(0, Math.min(100, (feature.score || 0) * 100));
            meterEl.style.width = `${percentage}%`;
            
            // 特別扱いを削除。feature.score（= wagScore）で幅更新に統一
        }
    }
    
    /* ===================== chart interaction ===================== */
    
    setupChartClickHandler(chart, metrics) {
        if (!chart || !metrics) return;
        
        chart.options.onClick = (event, elements) => {
            if (elements.length > 0) {
                const dataIndex = elements[0].index;
                const currentMetric = metrics[dataIndex];
                if (currentMetric) {
                    this.updateFeatureDisplay(currentMetric);
                    
                    // 時刻表示も更新
                    const timeEl = document.getElementById('currentTime');
                    if (timeEl) {
                        timeEl.textContent = currentMetric.timeCenter.toFixed(1);
                    }
                    
                    // ビデオシークも実行
                    const video = document.getElementById('resultVideo');
                    if (video && !isNaN(currentMetric.timeCenter)) {
                        video.currentTime = currentMetric.timeCenter;
                    }
                }
            }
        };
        
        // マウスホバーでも特徴量表示を更新
        chart.options.onHover = (event, elements) => {
            if (elements.length > 0) {
                const dataIndex = elements[0].index;
                const currentMetric = metrics[dataIndex];
                if (currentMetric) {
                    this.updateFeatureDisplay(currentMetric);
                }
            }
        };
        
        chart.update();
    }

    /* ===================== posture helpers ===================== */
    
    norm2(ax, ay){ 
        const n = Math.hypot(ax, ay); 
        return n ? [ax/n, ay/n] : [0,0]; 
    }
    
    angleDeg(ax, ay, bx, by){ // angle between vectors (deg)
        const [u1,u2]=this.norm2(ax,ay), [v1,v2]=this.norm2(bx,by);
        let c = u1*v1 + u2*v2; c = Math.max(-1, Math.min(1,c));
        return Math.acos(c)*180/Math.PI;
    }
    
    movingAvg(arr, k){ 
        if(!k||k<=1) return arr.slice();
        const out=new Array(arr.length).fill(0); let s=0;
        for(let i=0;i<arr.length;i++){ 
            s+=arr[i]; 
            if(i>=k) s-=arr[i-k]; 
            out[i]= s/Math.min(i+1,k); 
        }
        return out;
    }
    
    median(arr){ 
        const v=arr.filter(Number.isFinite).slice().sort((a,b)=>a-b); 
        if(!v.length) return NaN;
        const m=Math.floor(v.length/2); 
        return v.length%2?v[m]:(v[m-1]+v[m])/2;
    }
    
    percentile(arr,p){ 
        const v=arr.filter(Number.isFinite).slice().sort((a,b)=>a-b); 
        if(!v.length) return NaN;
        const i=(p/100)*(v.length-1); 
        const lo=Math.floor(i), hi=Math.ceil(i); 
        if(lo===hi) return v[lo];
        return v[lo] + (v[hi]-v[lo])*(i-lo);
    }
    
    // 簡易DFT帯域パワー（既存があればそれを使ってOK）
    bandPowerDFT(series, fs, f1, f2){
        const N=series.length; 
        if(N<4) return 0; 
        const re=new Array(N).fill(0), im=new Array(N).fill(0);
        for(let k=0;k<N;k++){
            let sr=0, si=0; 
            for(let n=0;n<N;n++){ 
                const ang=-2*Math.PI*k*n/N; 
                sr+=series[n]*Math.cos(ang); 
                si+=series[n]*Math.sin(ang); 
            }
            re[k]=sr; im[k]=si;
        }
        const Pxx = re.map((r,i)=> (r*r + im[i]*im[i]) / N);
        const df = fs/N;
        let sum=0; 
        for(let k=Math.max(0,Math.floor(f1/df)); k<=Math.min(N-1,Math.ceil(f2/df)); k++){ 
            sum+=Pxx[k]; 
        }
        return sum;
    }

    /* ===================== posture analysis ===================== */
    
    // 胴体中心速度・移動フラグ・脊柱の直線度（0〜1）をフレーム毎に算出
    estimatePostureSignals(coordinates, mapping, fps, confidence=0.5){
        const N = coordinates._metadata.numFrames;
        const like = coordinates._likelihood;

        const cx=new Array(N).fill(NaN), cy=new Array(N).fill(NaN);
        const speed=new Array(N).fill(0), moving=new Array(N).fill(false);
        const straight=new Array(N).fill(0);

        // 胴体長の代表値（しきい値スケール用）
        const torsoLens=[];
        for(let i=0;i<N;i++){
            const nb=mapping.neck_base, bm=mapping.back_middle;
            if(nb && bm && like[nb][i]>=confidence && like[bm][i]>=confidence){
                const x1=coordinates[nb].x[i], y1=coordinates[nb].y[i];
                const x2=coordinates[bm].x[i], y2=coordinates[bm].y[i];
                if(Number.isFinite(x1)&&Number.isFinite(y1)&&Number.isFinite(x2)&&Number.isFinite(y2)){
                    torsoLens.push(Math.hypot(x2-x1,y2-y1));
                    cx[i]=(x1+x2)/2; cy[i]=(y1+y2)/2;
                }
            }
        }
        const torsoMedian = this.median(torsoLens) || 60; // px, フォールバック

        // 速度(px/s)
        for(let i=1;i<N;i++){
            if(Number.isFinite(cx[i])&&Number.isFinite(cy[i])&&Number.isFinite(cx[i-1])&&Number.isFinite(cy[i-1])){
                const d = Math.hypot(cx[i]-cx[i-1], cy[i]-cy[i-1]);
                speed[i] = d * fps;
            }
        }
        const speedSm = this.movingAvg(speed, Math.max(1, Math.round(0.20*fps))); // 0.2秒平滑
        const moveThr = Math.max(12, 0.30*torsoMedian); // 動いている判定（px/s）
        for(let i=0;i<N;i++) moving[i] = speedSm[i] > moveThr;

        // 脊柱の直線度（|cosθ|：back_end–back_middle と neck_base–back_middle のなす角）
        for(let i=0;i<N;i++){
            const be=mapping.back_end, bm=mapping.back_middle, nb=mapping.neck_base;
            if(be&&bm&&nb && like[be][i]>=confidence && like[bm][i]>=confidence && like[nb][i]>=confidence){
                const bx=coordinates[be].x[i]-coordinates[bm].x[i];
                const by=coordinates[be].y[i]-coordinates[bm].y[i];
                const nx=coordinates[nb].x[i]-coordinates[bm].x[i];
                const ny=coordinates[nb].y[i]-coordinates[bm].y[i];
                const [ubx,uby]=this.norm2(bx,by), [unx,uny]=this.norm2(nx,ny);
                const cos = ubx*unx + uby*uny;
                straight[i] = Math.abs(cos); // 0=曲がり, 1=一直線
            } else {
                straight[i] = 0;
            }
        }

        return { speed: speedSm, moving, straight, torsoMedian };
    }
}

// ファイル末尾
if (typeof window !== 'undefined') {
  window.MultiHeaderCSVAnalyzer = MultiHeaderCSVAnalyzer;
}
