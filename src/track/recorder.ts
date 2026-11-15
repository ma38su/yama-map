/**
 * GPS による軌跡記録。
 *
 * 電池と精度のバランスのため、
 *  - 精度が悪い測位（誤差40m超）は捨てる
 *  - 前回記録点から一定距離（8m以上・誤差の半分以上）動いたときだけ記録する
 *  - 歩行ではありえない速度の飛び（GPSの跳ね）は捨てる
 * 標高はGPS高度ではなく国土地理院の標高タイルから求める（GPS高度は誤差が大きいため）。
 * 気圧計がある端末（アプリ版）では、気圧の変化で標高を補う（./baroAltitude.ts）。
 *
 * 注意: Web(PWA)では画面を消す・他のアプリに切り替えると測位が止まる。
 * そのため記録中は Screen Wake Lock で画面を点けたままにできるようにしている。
 * Androidアプリ版ではネイティブのバックグラウンド測位を使うので、画面を消しても記録が続く（./location.ts）。
 */
import { GainCounter, distance, formatDistance } from '../geo';
import { log } from '../log';
import type { DemSampler } from '../map/gsiDem';
import { BaroFusion } from './baroAltitude';
import { appendPoints, getPoints, putTrack, updateElevations, type Track, type TrackPoint } from './db';
import { pointsIn } from './trim';
import {
  backgroundCapable,
  clearRecordedFixes,
  currentPressure,
  readRecordedFixes,
  requestTrackingPermissions,
  watchLocation,
  type Fix,
  type LocationWatch,
} from './location';

const MAX_ACCURACY_M = 40;
const MIN_STEP_M = 8;
const MAX_SPEED_MPS = 12;
/** まとめて取り込んでいるときも、この点数ごとに保存する（裏で長く記録したあと、取り込み終わるまで待たないように） */
const SAVE_EVERY = 50;
/** 保存に失敗したら、点が増えなくてもこの間隔でやり直す */
const RETRY_MS = 15_000;

export interface RecorderState {
  track: Track | null;
  points: TrackPoint[];
  lastFix: Fix | null;
  error: string | null;
  /** 端末への保存に失敗している（やり直して保存できたら false に戻る。まとめて取り込んでいる途中の、まだ書いていない点は含めない） */
  saveFailed: boolean;
  wakeLock: boolean;
}

export class TrackRecorder {
  private track: Track | null = null;
  private points: TrackPoint[] = [];
  private gain = new GainCounter();
  private baro = new BaroFusion();
  private watch: LocationWatch | null = null;
  private lastFix: Fix | null = null;
  private error: string | null = null;
  private rejectedJumps = 0;
  /** 最初の点の歩数（記録の歩数はそこからの差）。歩数がまだなければ null */
  private firstSteps: number | null = null;
  /** まだ端末に保存していない点（まとめて取り込んでいる途中のもの・保存に失敗したもの）。次の保存でまとめて書く */
  private unsaved: TrackPoint[] = [];
  /** 最後の保存が失敗した */
  private saveFailed = false;
  private retryTimer = 0;
  private queue: Promise<void> = Promise.resolve();
  /** 記録を始めている・続けている途中（「記録開始」を続けて押したときなどに、二重に始めないように） */
  private starting = false;
  /** 終えている途中の記録（二重に終えないように、2回目は同じものを待つ） */
  private stopping: Promise<Track | null> | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  keepScreenOn = true;

  constructor(
    private readonly dem: DemSampler,
    private readonly onChange: (s: RecorderState) => void,
  ) {
    document.addEventListener('visibilitychange', () => {
      if (!this.recording) return;
      // 裏に回るときは、まだ書いていない点を書いておく（そのままアプリが閉じられても残るように）
      if (document.visibilityState === 'hidden') {
        this.flush();
        return;
      }
      // Web版はバックグラウンドから戻ったら測位を取り直す（iOSで止まることがあるため）。
      // アプリ版の測位はバックグラウンドでも続いているので、そのままにする
      if (!backgroundCapable) void this.startWatch();
      void this.acquireWakeLock();
    });
  }

  get recording(): boolean {
    return this.track?.status === 'recording';
  }

  get state(): RecorderState {
    return {
      track: this.track,
      points: this.points,
      lastFix: this.lastFix,
      error: this.error,
      saveFailed: this.saveFailed,
      wakeLock: this.wakeLock != null,
    };
  }

  /** 記録を始める（route は経路名）。位置情報が許可されていなければ始めずに false */
  async start(route?: string): Promise<boolean> {
    if (this.recording || this.starting) return true;
    this.starting = true;
    try {
      return await this.begin(route);
    } finally {
      this.starting = false;
    }
  }

  private async begin(route?: string): Promise<boolean> {
    // 許可を先に求める（拒否されたときに、点のない「記録中」の記録を残さないように）
    if (!(await requestTrackingPermissions())) return false;
    const now = Date.now();
    const d = new Date(now);
    const label = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    this.track = {
      id: crypto.randomUUID(),
      name: `${label} の記録`,
      startedAt: now,
      status: 'recording',
      distance: 0,
      ascent: 0,
      descent: 0,
      pointCount: 0,
      ...(route ? { route } : {}),
    };
    this.points = [];
    this.unsaved = [];
    this.saveFailed = false;
    this.firstSteps = null;
    this.gain = new GainCounter();
    this.baro = new BaroFusion();
    this.error = null;
    // 記録がブラウザに消されないよう、保存領域の永続化を求める（拒否されても続ける）
    void navigator.storage?.persist?.().catch(() => false);
    await putTrack(this.track);
    log(`記録を開始（${this.track.id.slice(0, 8)}）`);
    await this.startWatch();
    await this.acquireWakeLock();
    this.emit();
    return true;
  }

  /** 前回途中で閉じられた記録を再開する（アプリ版で裏で記録が続いていれば、そのまま続ける） */
  async resume(track: Track): Promise<void> {
    // もう記録している（読み込み中に「記録開始」を押した）なら、何もしない
    if (this.recording || this.starting) return;
    this.starting = true;
    try {
      await this.load(track);
      log(`記録を続ける（${track.id.slice(0, 8)}・${this.points.length}点）`);
      await requestTrackingPermissions();
      await this.startWatch();
      await this.acquireWakeLock();
      this.emit();
    } finally {
      this.starting = false;
    }
  }

  /** 記録を終える。アプリ版は端末にたまっている測位を取り込み終えてから締める。endedAt は終えた時刻（通知の「停止」のとき） */
  stop(endedAt = Date.now()): Promise<Track | null> {
    if (!this.track) return Promise.resolve(null);
    // 終えている途中（通知の「停止」とアプリの「記録終了」が重なったときなど）なら、同じものを待つ
    this.stopping ??= (async () => {
      try {
        const drained = await this.stopWatch();
        await this.queue;
        return await this.close(endedAt, drained);
      } finally {
        this.stopping = null;
      }
    })();
    return this.stopping;
  }

  /**
   * 途中で閉じられた記録を、再開せずに締める（アプリ版では、端末に残っている測位を取り込んでから）。
   * endedAt がなければ最後の点の時刻
   */
  async finish(track: Track, endedAt?: number): Promise<Track> {
    await this.load(track);
    this.emit();
    let drained = true;
    try {
      await readRecordedFixes(track.id, this.points.at(-1)?.t ?? 0, (fix) => this.enqueue(fix));
    } catch (e) {
      console.error('端末に残った測位を取り込めませんでした（次に開いたときにもう一度取り込みます）', e);
      drained = false;
    }
    await this.queue;
    return (await this.close(endedAt ?? this.points.at(-1)?.t ?? track.startedAt, drained))!;
  }

  /** drained：アプリ版の端末側の測位をすべて取り込めたか（取り込めていなければ、端末側の測位を消さない） */
  private async close(endedAt: number, drained: boolean | void = true): Promise<Track | null> {
    if (!this.track) return null;
    this.track = { ...this.track, status: 'done', endedAt };
    clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    await this.save();
    log(`記録を終了（${this.track.id.slice(0, 8)}・${this.points.length}点・${formatDistance(this.track.distance)}${this.unsaved.length ? `・保存できていない点 ${this.unsaved.length}` : ''}${drained === false ? '・端末に測位が残っている' : ''}）`);
    // IndexedDB に保存し終えたら、アプリ版の端末側の測位は消す（残っていれば、次に開いたときに取り込む：app/recording.ts）
    if (!this.unsaved.length && drained !== false) await clearRecordedFixes(this.track.id);
    await this.releaseWakeLock();
    const finished = this.track;
    this.emit();
    return finished;
  }

  /** 保存してある記録と点を読み込み、続きを記録できるようにする */
  private async load(track: Track): Promise<void> {
    this.track = { ...track, status: 'recording' };
    this.points = await getPoints(track.id);
    this.firstSteps = this.points.find((p) => p.steps != null)?.steps ?? null;
    this.unsaved = [];
    this.saveFailed = false;
    this.rejectedJumps = 0;
    this.error = null;
    this.gain = new GainCounter();
    this.baro = new BaroFusion();
    for (const p of this.points) {
      this.gain.push(p.ele);
      if (p.hpa != null) this.baro.push(p.t, p.hpa, p.dem ?? p.ele);
    }
  }

  /** 記録中の今の標高を気圧計から求める（気圧計がない・まだ合わせられていなければ null） */
  async currentAltitude(): Promise<number | null> {
    if (!this.recording) return null;
    const hpa = await currentPressure();
    return hpa != null ? this.baro.altitude(hpa) : null;
  }

  /** 経路名・ロックなど、記録の仕組みの外で変えて保存したものを、持っている記録にも入れる（保存はしない） */
  relabel(id: string, patch: Partial<Pick<Track, 'route' | 'locked'>>): void {
    if (this.track?.id !== id) return;
    this.track = { ...this.track, ...patch };
    this.emit();
  }

  /** 記録終了後の表示をクリア */
  clear(): void {
    if (this.recording) return;
    this.track = null;
    this.points = [];
    this.emit();
  }

  async setKeepScreenOn(on: boolean): Promise<void> {
    this.keepScreenOn = on;
    if (on && this.recording) await this.acquireWakeLock();
    if (!on) await this.releaseWakeLock();
    this.emit();
  }

  private enqueue(fix: Fix): void {
    this.lastFix = fix;
    this.error = null;
    this.queue = this.queue.then(() => this.handle(fix)).catch((e) => console.error(e));
  }

  private async startWatch(): Promise<void> {
    const track = this.track;
    if (!track) return;
    // 前の測位を止め終えてから始める（前の止める依頼が、新しい記録を止めないように）
    await this.stopWatch();
    this.watch = watchLocation(
      (fix) => this.enqueue(fix),
      (err) => {
        // 一時的な取得失敗は、直近20秒以内に測位できていれば表示しない
        const recent = this.lastFix && Date.now() - this.lastFix.timestamp < 20_000;
        if (err !== 'denied' && recent) return;
        this.error =
          err === 'denied' ? '位置情報の利用が許可されていません' : '現在地を取得できません（GPSの電波が弱い可能性があります）';
        this.emit();
      },
      {
        trackId: track.id,
        startedAt: track.startedAt,
        since: this.points.at(-1)?.t ?? 0,
        // 通知の「停止」で止められたら、ここまでで締める
        onEnded: (endedAt) => void this.stop(endedAt),
      },
    );
  }

  /** 測位をやめる。アプリ版で、端末側の測位を取り込みきれなかったら false */
  private async stopWatch(): Promise<boolean> {
    const watch = this.watch;
    this.watch = null;
    return (await watch?.stop()) ?? true;
  }

  private async handle(pos: Fix): Promise<void> {
    const track = this.track;
    if (!track || track.status !== 'recording') return;
    const { lng, lat, accuracy, altitude } = pos;
    if (accuracy > MAX_ACCURACY_M) return this.settle(pos);
    const last = this.points[this.points.length - 1];
    let step = 0;
    if (last) {
      step = distance([last.lng, last.lat], [lng, lat]);
      if (step < Math.max(MIN_STEP_M, accuracy / 2)) return this.settle(pos);
      const dt = (pos.timestamp - last.t) / 1000;
      if (dt > 0 && step / dt > MAX_SPEED_MPS && this.rejectedJumps < 3) {
        this.rejectedJumps++;
        return this.settle(pos);
      }
    }
    this.rejectedJumps = 0;
    // 標高タイルが手元になければ、待つのは少しだけ（まとめて取り込んでいるときは待たない）。
    // 取れなかった標高は、記録を終えたときに埋める（fillMissingElevations）。電波が弱いと1枚に何秒もかかるため
    const dem = await this.dem.elevation(lng, lat, pos.more ? 0 : 1000);
    // 気圧はアプリ版で測位と一緒に残したもの（取り込むのが後になっても、その時の気圧）。Web 版にはない
    const hpa = pos.hpa ?? null;
    const ele = hpa != null ? this.baro.push(pos.timestamp, hpa, dem) : dem;
    const point: TrackPoint = {
      trackId: track.id,
      t: pos.timestamp,
      lng,
      lat,
      alt: altitude,
      acc: accuracy,
      ele,
      ...(hpa != null ? { hpa, dem } : {}),
      ...(pos.steps != null ? { steps: pos.steps } : {}),
    };
    this.points.push(point);
    this.gain.push(ele);
    this.track = {
      ...track,
      distance: track.distance + step,
      ascent: this.gain.ascent,
      descent: this.gain.descent,
      pointCount: this.points.length,
      // 歩数は、最初の点からの歩数（点の歩数は記録を始めてからの歩数なので、範囲を変えたときと同じく差を取る）
      ...(pos.steps != null ? { steps: Math.max(0, pos.steps - (this.firstSteps ??= pos.steps)) } : {}),
    };
    this.unsaved.push(point);
    await this.settle(pos);
  }

  /**
   * ふだんの測位は毎回、たまった点を保存して知らせる。
   * まとめて取り込んでいるあいだは SAVE_EVERY 点ごとに保存し、知らせるのは最後の1点で
   */
  private async settle(pos: Fix): Promise<void> {
    if (pos.more) {
      if (this.unsaved.length >= SAVE_EVERY) await this.save();
      return;
    }
    if (this.unsaved.length) await this.save();
    this.emit();
  }

  /** まだ書いていない点を、順番待ちの後ろで保存する（裏に回るとき・やり直しのとき） */
  private flush(): void {
    this.queue = this.queue
      .then(async () => {
        if (!this.track || (!this.unsaved.length && !this.saveFailed)) return;
        const failed = this.saveFailed;
        await this.save();
        if (failed !== this.saveFailed) this.emit();
      })
      .catch((e) => console.error(e));
  }

  /** 記録の概要と、まだ保存できていない点を保存する。失敗したら点は覚えておき、少し待ってやり直す（次の点が届いたときも） */
  private async save(): Promise<void> {
    if (!this.track) return;
    const points = this.unsaved;
    try {
      if (points.length) await appendPoints(this.track, points);
      else await putTrack(this.track);
      this.unsaved = this.unsaved.slice(points.length);
      if (this.saveFailed) log(`記録を保存し直せた（${points.length}点）`);
      this.saveFailed = false;
      clearTimeout(this.retryTimer);
      this.retryTimer = 0;
    } catch (e) {
      // 1回目の失敗だけ残す（やり直しのたびにログが増えないように）
      if (!this.saveFailed) console.error(`記録を保存できませんでした（${points.length}点。${RETRY_MS / 1000}秒ごとにやり直します）`, e);
      this.saveFailed = true;
      if (this.recording && !this.retryTimer) {
        this.retryTimer = window.setTimeout(() => {
          this.retryTimer = 0;
          this.flush();
        }, RETRY_MS);
      }
    }
  }

  private async acquireWakeLock(): Promise<void> {
    if (!this.keepScreenOn || !('wakeLock' in navigator) || this.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        this.wakeLock = null;
        this.emit();
      });
    } catch {
      this.wakeLock = null;
    }
  }

  private async releaseWakeLock(): Promise<void> {
    const lock = this.wakeLock;
    this.wakeLock = null;
    await lock?.release().catch(() => undefined);
  }

  private emit(): void {
    this.onChange(this.state);
  }
}

/**
 * 標高が取れていない点（圏外で標高タイルを読めなかったときなど）を標高タイルから埋めて保存し、登り・下りを数え直す。
 * points の標高はその場で書き換える。埋められた点がなければ null
 */
export async function fillMissingElevations(
  track: Track,
  points: TrackPoint[],
  elevation: (lng: number, lat: number) => Promise<number | null>,
): Promise<Track | null> {
  const eles = new Map<number, number>();
  for (const p of points) {
    if (p.ele != null) continue;
    const ele = await elevation(p.lng, p.lat);
    if (ele != null) eles.set(p.t, ele);
  }
  if (!eles.size) return null;
  for (const p of points) p.ele ??= eles.get(p.t) ?? null;
  // 登り・下りは記録の範囲（trim）の中で数え直す
  const gain = new GainCounter();
  for (const p of pointsIn(points, track.trim)) gain.push(p.ele);
  const updated = { ...track, ascent: gain.ascent, descent: gain.descent };
  await updateElevations(track.id, eles);
  await putTrack(updated);
  return updated;
}
