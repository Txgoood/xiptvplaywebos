import React, { useRef, useState, useEffect, useCallback } from 'react';
import Hls from 'hls.js';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { MediaItem, DownloadItem } from '../../types';
import { isNative } from '../../services/net';
import { XtreamClientService } from '../../services/xtreamClient';
import { StorageService } from '../../services/storage';
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  Maximize2,
  Sliders,
  X,
  AlertTriangle,
  Sun,
  Gauge,
  Subtitles,
  Upload,
  FastForward,
  Rewind,
  Check,
  ShieldCheck,
  Zap,
  RefreshCw,
  Tv,
  Copy,
} from 'lucide-react';

interface VideoPlayerModalProps {
  media: MediaItem | DownloadItem | null;
  isOpen: boolean;
  onClose: () => void;
}

const PLAYBACK_SPEEDS = [0.5, 1.0, 1.25, 1.5, 2.0];

const NativeMediaPlayer = registerPlugin<{
  play(options: { url: string; title: string; isLocalFile?: boolean; bufferSeconds?: number; nextUrl?: string; nextTitle?: string; nextNextUrl?: string; nextNextTitle?: string }): Promise<{ started: boolean; returnedToInline?: boolean; positionMs?: number }>;
  stop(): Promise<void>;
}>('NativeMediaPlayer');

// 4 Kademeli Otomatik Kurtarma (Auto-Fallback) Seviyeleri:
// 1. proxy-hls: Proxy + HLS.js (M3U8 / HLS akışları)
// 2. proxy-native: Proxy + HTML5 Native (206 Range MP4/MKV akışları)
// 3. direct: Doğrudan Ham Akış URL'si (Direct Stream)
// 4. sample: Test akışı (Big Buck Bunny)
// 5. failed: Tüm denemeler başarısız olduğunda kullanıcı bilgilendirme ekranı
export type FallbackStage = 'proxy-hls' | 'proxy-native' | 'direct' | 'sample' | 'failed';

export const VideoPlayerModal: React.FC<VideoPlayerModalProps> = ({
  media,
  isOpen,
  onClose,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const nativeLaunchKeyRef = useRef<string | null>(null);
  const nativeResumePositionRef = useRef(0);

  const handleClosePlayer = () => {
    if (Capacitor.getPlatform() === 'android') {
      NativeMediaPlayer.stop().catch((error) => {
        console.warn('[NativeMediaPlayer] Could not stop native playback:', error);
      }).finally(() => onClose());
      return;
    }
    onClose();
  };

  // Playback Auto-Fallback Stage: Always defaults to 'proxy-hls' on open
  const [fallbackStage, setFallbackStage] = useState<FallbackStage>('proxy-hls');
  const [isHlsActive, setIsHlsActive] = useState(false);
  const [hlsLevels, setHlsLevels] = useState<{ id: number; name: string }[]>([]);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);

  // Core Playback State
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.85);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [brightness, setBrightness] = useState(1.0); // 0.2 to 1.5
  const [quality, setQuality] = useState('Otomatik');
  const [audioTrack, setAudioTrack] = useState('Varsayılan');
  const [availableAudioTracks, setAvailableAudioTracks] = useState<{ id: number; name: string }[]>([]);
  const [availableSubtitleTracks, setAvailableSubtitleTracks] = useState<{ id: number; name: string }[]>([]);
  const [trackSource, setTrackSource] = useState<'hls' | 'native' | 'none'>('none');

  // webOS native HTML5 and HLS expose different track lists.
  // Never claim a language exists unless the active playback engine reports it.
  const refreshMediaTracks = useCallback(() => {
    const video = videoRef.current;
    const hls = hlsRef.current;
    if (hls && isHlsActive) {
      setTrackSource('hls');
      setAvailableAudioTracks(hls.audioTracks.map((t, id) => ({
        id, name: t.name || t.lang || `Ses ${id + 1}`,
      })));
      setAvailableSubtitleTracks(hls.subtitleTracks.map((t, id) => ({
        id, name: t.name || t.lang || `Altyazı ${id + 1}`,
      })));
      setAudioTrack(hls.audioTrack >= 0 && hls.audioTracks[hls.audioTrack]
        ? (hls.audioTracks[hls.audioTrack].name || hls.audioTracks[hls.audioTrack].lang || `Ses ${hls.audioTrack + 1}`)
        : 'Varsayılan');
      return;
    }
    const nativeAudio = video ? (video as HTMLVideoElement & {
      audioTracks?: { length: number; [index: number]: { label?: string; language?: string; enabled?: boolean } };
    }).audioTracks : undefined;
    setTrackSource(video ? 'native' : 'none');
    setAvailableAudioTracks(nativeAudio
      ? Array.from({ length: nativeAudio.length }, (_, id) => ({
          id, name: nativeAudio[id].label || nativeAudio[id].language || `Ses ${id + 1}`,
        })) : []);
    setAvailableSubtitleTracks(video
      ? Array.from(video.textTracks).filter(t => t.kind === 'subtitles' || t.kind === 'captions')
          .map((t, id) => ({ id, name: t.label || t.language || `Altyazı ${id + 1}` }))
      : []);
  }, [isHlsActive]);

  const selectAudioTrack = (id: number) => {
    const hls = hlsRef.current;
    if (hls && isHlsActive) hls.audioTrack = id;
    else {
      const tracks = (videoRef.current as (HTMLVideoElement & {
        audioTracks?: { length: number; [index: number]: { enabled?: boolean } };
      }) | null)?.audioTracks;
      if (!tracks || id >= tracks.length) return;
      for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === id;
    }
    setAudioTrack(availableAudioTracks.find(t => t.id === id)?.name || 'Varsayılan');
  };

  const selectSubtitleTrack = (id: number | null) => {
    const hls = hlsRef.current;
    if (hls && isHlsActive) {
      hls.subtitleDisplay = id !== null;
      hls.subtitleTrack = id === null ? -1 : id;
    } else if (videoRef.current) {
      const tracks = Array.from(videoRef.current.textTracks)
        .filter(t => t.kind === 'subtitles' || t.kind === 'captions');
      tracks.forEach((track, index) => { track.mode = id === index ? 'showing' : 'disabled'; });
    }
    setSubtitleTrack(id === null ? 'Kapalı' : availableSubtitleTracks.find(t => t.id === id)?.name || 'Kapalı');
  };

  // Subtitle State (.srt / .vtt)
  const [subtitleTrack, setSubtitleTrack] = useState('Kapalı');
  const [customSubtitleUrl, setCustomSubtitleUrl] = useState<string | null>(null);
  const [customSubtitleName, setCustomSubtitleName] = useState<string | null>(null);

  // UI & Menu State
  const [showControls, setShowControls] = useState(true);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [nativePlayerUnavailable, setNativePlayerUnavailable] = useState(false);

  // Gesture HUD & Ripple Feedback States
  const [hudFeedback, setHudFeedback] = useState<{ icon: 'volume' | 'brightness'; text: string } | null>(null);
  const [rippleFeedback, setRippleFeedback] = useState<{ type: 'rewind' | 'forward'; id: number } | null>(null);

  // Touch Tracking & Watchdog Refs
  const touchStartXRef = useRef(0);
  const touchStartYRef = useRef(0);
  const lastTapTimeRef = useRef(0);
  const singleTapTimeoutRef = useRef<any>(null);
  const hideControlsTimerRef = useRef<any>(null);
  const hudTimerRef = useRef<any>(null);
  const noticeTimerRef = useRef<any>(null);
  const hlsWatchdogTimerRef = useRef<any>(null);
  const nativeWatchdogTimerRef = useRef<any>(null);
  const autoRecoveryTimerRef = useRef<any>(null);
  const autoTriggerCountRef = useRef(0);
  const networkRetryCountRef = useRef(0);
  const mediaRetryCountRef = useRef(0);
  const [autoTriggerCountdown, setAutoTriggerCountdown] = useState<number | null>(null);

  // Fallback sample stream if the provider stream is completely offline
  const sampleFallbackUrl =
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

  // Helper to extract the direct raw stream URL from either rawStreamUrl or proxy query param
  const extractRawUrl = useCallback((item: MediaItem | DownloadItem | null): string | null => {
    if (!item) return null;
    if (item.rawStreamUrl) return item.rawStreamUrl;
    const url = item.streamUrl;
    if (!url) return null;
    if (url.includes('/api/iptv/proxy?url=')) {
      try {
        const match = url.match(/url=([^&]+)/);
        if (match && match[1]) {
          return decodeURIComponent(match[1]);
        }
      } catch {
        // ignore
      }
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    return null;
  }, []);

  const rawUrl = (() => {
    const u = extractRawUrl(media);
    return u ? XtreamClientService.toHlsLiveUrl(u) : u;
  })();

  // Helper to generate the proxy URL (/api/iptv/proxy?url=...)
  const getProxyUrl = useCallback((targetUrl: string | null | undefined): string => {
    if (!targetUrl) return sampleFallbackUrl;
    if (isNative()) return targetUrl; // APK: No proxy
    if (targetUrl.startsWith('/api/iptv/proxy')) return targetUrl;
    return `/api/iptv/proxy?url=${encodeURIComponent(targetUrl)}`;
  }, [sampleFallbackUrl]);

  // Check if browser environment is HTTPS and target URL is HTTP (Mixed Content risk)
  const isHttpsEnvironment = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const isHttpUrl = useCallback((url: string | null | undefined): boolean => {
    return !!url && url.toLowerCase().startsWith('http://');
  }, []);

  // Compute effective playback URL based on active fallbackStage
  const getEffectiveVideoUrl = useCallback(() => {
    if (!media) return sampleFallbackUrl;
    
    // Android Media3/ExoPlayer dosyanın gerçek file:// URI'sini doğrudan açmalı.
    // Web oynatıcı ise Capacitor'ın dönüştürdüğü localUrl adresini kullanır.
    if (Capacitor.getPlatform() === 'android' && 'fileUri' in media && media.fileUri) {
      return media.fileUri;
    }
    if ('localUrl' in media && media.localUrl) return media.localUrl;
    if ('fileUri' in media && media.fileUri) return Capacitor.convertFileSrc(media.fileUri);
    
    if (fallbackStage === 'sample') return sampleFallbackUrl;
    
    const targetRaw = rawUrl || media.streamUrl;
    
    if (fallbackStage === 'direct') {
      // 1- Direct Stream Modunda Karma İçerik (Mixed Content) & Port Engeli Koruması:
      // HTTPS altında veya port kısıtlı sunucularda güvenli proxy tüneli üzerinden zorla akıt
      if (isHttpsEnvironment || isHttpUrl(targetRaw) || (targetRaw && targetRaw.includes(':'))) {
        return getProxyUrl(targetRaw);
      }
      return targetRaw || sampleFallbackUrl;
    }
    
    // Default: 'proxy-hls' or 'proxy-native' -> Route through /api/iptv/proxy
    return getProxyUrl(targetRaw);
  }, [media, fallbackStage, rawUrl, getProxyUrl, sampleFallbackUrl, isHttpsEnvironment, isHttpUrl]);
  const effectiveUrl = getEffectiveVideoUrl();

  // Reset auto-hide timer for overlay controls
  const resetControlsTimeout = useCallback(() => {
    setShowControls(true);
    if (hideControlsTimerRef.current) {
      clearTimeout(hideControlsTimerRef.current);
    }
    hideControlsTimerRef.current = setTimeout(() => {
      setShowControls(false);
      setShowSettingsMenu(false);
    }, 4000);
  }, []);

  // Show a brief notice banner (e.g. for automatic fallback transitions)
  const triggerNotice = useCallback((message: string) => {
    setFallbackNotice(message);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => {
      setFallbackNotice(null);
    }, 4500);
  }, []);

  // Manual & Auto Trigger functions for HLS and Secure Tunnel
  const triggerRetryHls = useCallback(() => {
    if (autoRecoveryTimerRef.current) {
      clearTimeout(autoRecoveryTimerRef.current);
      autoRecoveryTimerRef.current = null;
    }
    setAutoTriggerCountdown(null);
    networkRetryCountRef.current = 0;
    mediaRetryCountRef.current = 0;
    setFallbackStage('proxy-hls');
    setPlaybackError(null);
    triggerNotice('⚡ HLS.js akış çözücü motoru başlatılıyor...');
  }, [triggerNotice]);

  const triggerRetryTunnel = useCallback(() => {
    if (autoRecoveryTimerRef.current) {
      clearTimeout(autoRecoveryTimerRef.current);
      autoRecoveryTimerRef.current = null;
    }
    setAutoTriggerCountdown(null);
    setFallbackStage('proxy-native');
    setPlaybackError(null);
    triggerNotice('🛡️ Güvenli Tünel (Proxy 206 Partial Content) başlatılıyor...');
  }, [triggerNotice]);

  // 4- Kademeli Hata Yakalama ve Otomatik Kurtarma (Auto-Fallback):
  // 1. Proxy + HLS.js (M3U8 / Canlı TV)
  // 2. Başarısız olursa Proxy + Native HTML5 (MP4 / MKV / TS doğrudan akış)
  // 3. O da başarısız olursa Doğrudan Medya Akışı / HTTPS Proxy Tüneli
  // 4. Hata durumunda "Güvenli Tünel" veya "HLS ile Dene" butonunu otomatik tetikle
  const triggerNextFallback = useCallback(
    (reason: string) => {
      console.warn(`[VideoPlayer] Stream error: "${reason}", Stage: ${fallbackStage}`);
      // Halt the automatic loop: Simply fail immediately.
      setFallbackStage('failed');
      const isDownloadedFile = !!(media && (('localUrl' in media && media.localUrl) || ('fileUri' in media && media.fileUri)));
      const isMkv = !!(media && 'offlinePath' in media && media.offlinePath && /\.mkv$/i.test(media.offlinePath));
      setPlaybackError(
        isDownloadedFile && isMkv
          ? 'Bu MKV dosyasının video/ses kodeği Android WebView oynatıcısıyla uyumlu olmayabilir. İndirme kartındaki “Dosyayı Aç / Paylaş” seçeneğiyle VLC gibi uyumlu bir harici oynatıcı seçin.'
          : isDownloadedFile
            ? 'İndirilen dosya uygulama içi oynatıcıda açılamadı. Dosya biçimi/kodeği desteklenmiyor olabilir. İndirme kartındaki “Dosyayı Aç / Paylaş” seçeneğini deneyin.'
            : `Yayın başlatılamadı (${reason}). IPTV sunucusu yanıt vermiyor, hesap/IP engelli olabilir veya video formatı tarayıcıda desteklenmiyor.`
      );
    },
    [fallbackStage, setPlaybackError]
  );

  const playbackSpeedRef = useRef(playbackSpeed);
  useEffect(() => { playbackSpeedRef.current = playbackSpeed; }, [playbackSpeed]);

  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = playbackSpeed; }, [playbackSpeed]);

  // Keep the native video element's audio state in sync after source/key changes.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.max(0, Math.min(1, volume));
    video.muted = isMuted || volume === 0;
  }, [volume, isMuted, isOpen, media?.id, fallbackStage]);

  // 1- Oynatıcı açılırken video kaynağını, başlıkları ve modu anında resetleyip sıfırdan yükleyin
  useEffect(() => {
    if (isOpen && media) {
      // VOD içerikler (Film, Dizi, MP4, MKV) için doğrudan Proxy + HTML5 Native ile başla
      // Canlı TV ve M3U8 akışları için Proxy + HLS.js ile başla
      const isDownloadedFile = ('status' in media && media.status === 'completed') && !!(media.localUrl || media.fileUri || media.offlinePath);
      const isVod =
        isDownloadedFile ||
        ('type' in media && (media.type === 'movie' || media.type === 'series')) ||
        (media.streamUrl && (media.streamUrl.includes('.mp4') || media.streamUrl.includes('.mkv'))) ||
        (rawUrl && (rawUrl.includes('.mp4') || rawUrl.includes('.mkv')));

      const initialStage: FallbackStage = isVod ? 'proxy-native' : 'proxy-hls';
      setFallbackStage(initialStage);
      autoTriggerCountRef.current = 0;
      setAutoTriggerCountdown(null);
      networkRetryCountRef.current = 0;
      mediaRetryCountRef.current = 0;
      setPlaybackError(null);
      setFallbackNotice(null);
      setCurrentTime(0);
      setDuration(0);
      setIsPlaying(true);
      setShowSettingsMenu(false);

      if (autoRecoveryTimerRef.current) {
        clearTimeout(autoRecoveryTimerRef.current);
        autoRecoveryTimerRef.current = null;
      }
      if (nativeWatchdogTimerRef.current) {
        clearTimeout(nativeWatchdogTimerRef.current);
        nativeWatchdogTimerRef.current = null;
      }
      if (hlsWatchdogTimerRef.current) {
        clearTimeout(hlsWatchdogTimerRef.current);
        hlsWatchdogTimerRef.current = null;
      }

      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.removeAttribute('src');
        videoRef.current.playbackRate = playbackSpeedRef.current;
        videoRef.current.load();
      }

      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      setIsHlsActive(false);
      setAvailableAudioTracks([]);
      setAvailableSubtitleTracks([]);
      setTrackSource('none');
      setAudioTrack('Varsayılan');
      setSubtitleTrack('Kapalı');
    }
  }, [isOpen, media?.id, rawUrl]);

  // Android APK uses the native Media3 / ExoPlayer screen; browser playback stays unchanged.
  useEffect(() => {
    if (!isOpen || !media) {
      nativeLaunchKeyRef.current = null;
      setNativePlayerUnavailable(false);
      return;
    }
    if (Capacitor.getPlatform() !== 'android' || nativePlayerUnavailable) return;

    const launchKey = String(media.id);
    if (nativeLaunchKeyRef.current === launchKey) return;
    nativeLaunchKeyRef.current = launchKey;

    const mediaData = media as any;
    const nextEpisode = mediaData.nextEpisode || mediaData.nextEpisodeItem || null;
    const nextEpisodeUrl = mediaData.nextEpisodeUrl || nextEpisode?.streamUrl || nextEpisode?.url || null;
    const nextEpisodeTitle = mediaData.nextEpisodeTitle || nextEpisode?.title || nextEpisode?.name || null;
    const nextNextEpisodeUrl = mediaData.nextNextEpisodeUrl || null;
    const nextNextEpisodeTitle = mediaData.nextNextEpisodeTitle || null;

    const localFileUri = typeof mediaData.fileUri === 'string' && mediaData.fileUri.startsWith('file://')
      ? mediaData.fileUri
      : null;
    // Never let the fallback/proxy URL replace a verified offline file URI.
    const playbackUrl = localFileUri || effectiveUrl;
    NativeMediaPlayer.play({
      url: playbackUrl,
      isLocalFile: !!localFileUri,
      title: media.title || 'XIPTV Play',
      bufferSeconds: Math.max(3, Math.min(45, Number(StorageService.getSettings().bufferSeconds) || 15)),
      ...(nextEpisodeUrl ? { nextUrl: nextEpisodeUrl } : {}),
      ...(nextEpisodeTitle ? { nextTitle: nextEpisodeTitle } : {}),
      ...(nextNextEpisodeUrl ? { nextNextUrl: nextNextEpisodeUrl } : {}),
      ...(nextNextEpisodeTitle ? { nextNextTitle: nextNextEpisodeTitle } : {}),
    })
      .then((result) => {
        if (result?.returnedToInline) {
          nativeResumePositionRef.current = Math.max(0, Number(result.positionMs || 0) / 1000);
          setNativePlayerUnavailable(true);
          triggerNotice('Uygulama içi oynatıcıya dönüldü.');
        } else {
          onClose();
        }
      })
      .catch((error) => {
        nativeLaunchKeyRef.current = null;
        setNativePlayerUnavailable(true);
        console.error('[NativeMediaPlayer] Could not start Media3 player:', error);
        triggerNotice('Yerel oynatıcı açılamadı; uygulama içi oynatıcı kullanılacak.');
      });
  }, [isOpen, media?.id, effectiveUrl, media?.title, onClose, triggerNotice, nativePlayerUnavailable]);

  // Akış motoru bağlama ve çalıştırma (HLS.js / Native Video)
  useEffect(() => {
    if (Capacitor.getPlatform() === 'android' && isOpen && media && !nativePlayerUnavailable) return;
    if (!isOpen || !media || !videoRef.current) {
      if (hlsRef.current) {        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      setIsHlsActive(false);
      return;
    }

    if (fallbackStage === 'failed') {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      setIsHlsActive(false);
      return;
    }

    const videoElement = videoRef.current;

    // Önceki HLS nesnesini güvenle temizle
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    setIsHlsActive(false);

    const currentUrl = effectiveUrl;

    // Clear any existing watchdog timer
    if (hlsWatchdogTimerRef.current) {
      clearTimeout(hlsWatchdogTimerRef.current);
      hlsWatchdogTimerRef.current = null;
    }

    // 2- hls.js ve Akış Çözücü Motor Entegrasyonu:
    // Kademe 'proxy-hls' ise veya URL doğrudan .m3u8 içeriyorsa Hls.isSupported() kontrolü yap
    if (fallbackStage === 'proxy-hls') {
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 60,
          maxBufferLength: 30,
          maxMaxBufferLength: 120,
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 10,
          capLevelToPlayerSize: true,
          manifestLoadingTimeOut: 12000,
          manifestLoadingMaxRetry: 3,
          manifestLoadingRetryDelay: 1000,
          levelLoadingTimeOut: 12000,
          levelLoadingMaxRetry: 3,
          levelLoadingRetryDelay: 1000,
          fragLoadingTimeOut: 20000,
          fragLoadingMaxRetry: 3,
          fragLoadingRetryDelay: 1000,
        });

        hlsRef.current = hls;
        hls.attachMedia(videoElement);

        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
          hls.loadSource(currentUrl);
        });

        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => setTimeout(refreshMediaTracks, 0));
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => setTimeout(refreshMediaTracks, 0));
        hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
          setIsHlsActive(true);
          setTimeout(refreshMediaTracks, 0);
          setPlaybackError(null);
          if (data.levels && data.levels.length > 0) {
            const lvls = data.levels.map((l, idx) => ({
              id: idx,
              name: `${l.height || 'Auto'}p (${Math.round((l.bitrate || 0) / 1000)} kbps)`,
            }));
            setHlsLevels(lvls);
          }
          videoElement.playbackRate = playbackSpeed;
          if (nativeResumePositionRef.current > 0 && Number.isFinite(videoElement.duration) && videoElement.duration > 0) {
            videoElement.currentTime = Math.min(nativeResumePositionRef.current, Math.max(0, videoElement.duration - 1));
            nativeResumePositionRef.current = 0;
          }
          videoElement
            .play()
            .then(() => setIsPlaying(true))
            .catch((err) => {
              console.warn('[VideoPlayer] Autoplay blocked, user interaction required:', err);
              setIsPlaying(false);
            });
        });

        // HLS.js Hata Yakalama ve Otomatik Kurtarma (hls.recoverMediaError / hls.startLoad):
        hls.on(Hls.Events.ERROR, (_event, data) => {
          console.warn('[HLS.js] Hata oluştu:', data.type, data.details, 'Fatal:', data.fatal);

          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                if (networkRetryCountRef.current < 3) {
                  networkRetryCountRef.current += 1;
                  console.warn(`[HLS.js] Ağ hatası yakalandı. Otomatik yeniden deneniyor (${networkRetryCountRef.current}/3)...`);
                  triggerNotice(`Ağ bağlantısı yenileniyor (${networkRetryCountRef.current}/3)...`);
                  hls.startLoad();
                } else {
                  console.warn('[HLS.js] Ağ deneme sınırı aşıldı. HTML5 Native oynatıcıya geçiliyor...');
                  hls.destroy();
                  hlsRef.current = null;
                  setIsHlsActive(false);
                  triggerNextFallback('hls_network_limit_reached');
                }
                break;

              case Hls.ErrorTypes.MEDIA_ERROR:
                if (mediaRetryCountRef.current < 3) {
                  mediaRetryCountRef.current += 1;
                  console.warn(`[HLS.js] Medya çözme hatası yakalandı. hls.recoverMediaError() çağrılıyor (${mediaRetryCountRef.current}/3)...`);
                  triggerNotice(`Medya hatası gideriliyor (${mediaRetryCountRef.current}/3)...`);
                  hls.recoverMediaError();
                } else {
                  console.warn('[HLS.js] Medya kurtarma başarısız. HTML5 Native oynatıcıya geçiliyor...');
                  hls.destroy();
                  hlsRef.current = null;
                  setIsHlsActive(false);
                  triggerNextFallback('hls_media_recovery_failed');
                }
                break;

              default:
                console.warn('[HLS.js] Kurtarılamayan hata (örn. MANIFEST_PARSING). HTML5 Native oynatıcıya geçiliyor...');
                hls.destroy();
                hlsRef.current = null;
                setIsHlsActive(false);
                triggerNextFallback(`hls_fatal_${data.details}`);
                break;
            }
          }
        });

        // 2- Siyah Ekran ve 0:00/0:00 Takılma Watchdog Koruması:
        // Eğer HLS akışı 10 saniye boyunca hiç veri alamazsa ve 0:00'da takılı kalırsa otomatik olarak HTML5 Native'e geç
        hlsWatchdogTimerRef.current = setTimeout(() => {
          if (videoRef.current && videoRef.current.currentTime === 0 && fallbackStage === 'proxy-hls') {
            console.warn('[HLS Watchdog] Akış 0:00/0:00 siyah ekranda takıldı. HTML5 Native oynatıcıya geçiliyor...');
            triggerNotice('⚡ HLS yanıt vermedi. HTML5 Native Oynatıcıya geçildi.');
            if (hlsRef.current) {
              hlsRef.current.destroy();
              hlsRef.current = null;
            }
            setIsHlsActive(false);
            setFallbackStage('proxy-native');
          }
        }, 10000);
      } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
        // Native Apple Safari / iOS HLS
        videoElement.src = currentUrl;
        videoElement.playbackRate = playbackSpeed;
        videoElement.load();
        videoElement
          .play()
          .then(() => setIsPlaying(true))
          .catch(() => {
            triggerNextFallback('safari_hls_play_failed');
          });
        setIsHlsActive(true);
      } else {
        // Tarayıcı MediaSource/Hls desteklemiyorsa doğrudan native HTML5'e geç
        triggerNextFallback('hls_not_supported');
      }
    } else {
      // Kademe 'proxy-native', 'direct' veya 'sample':
      // Native HTML5 Video (206 Range MP4/MKV partial content streams)
      videoElement.src = currentUrl;
      videoElement.playbackRate = playbackSpeed;
      if (nativeResumePositionRef.current > 0) {
        const restorePosition = () => {
          if (Number.isFinite(videoElement.duration) && videoElement.duration > 0) {
            videoElement.currentTime = Math.min(nativeResumePositionRef.current, Math.max(0, videoElement.duration - 1));
            nativeResumePositionRef.current = 0;
          }
        };
        videoElement.addEventListener('loadedmetadata', restorePosition, { once: true });
      }
      videoElement.load();
      videoElement
        .play()
        .then(() => {
          setIsPlaying(true);
          setPlaybackError(null);
        })
        .catch((err) => {
          if (err.name === 'NotAllowedError') {
            setIsPlaying(false);
          } else {
            console.warn('[VideoPlayer] Native play rejection:', err);
            triggerNextFallback('native_play_error');
          }        });
      setIsHlsActive(false);
    }

    resetControlsTimeout();

    return () => {
      if (hlsWatchdogTimerRef.current) {
        clearTimeout(hlsWatchdogTimerRef.current);
        hlsWatchdogTimerRef.current = null;
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
      if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
      if (singleTapTimeoutRef.current) clearTimeout(singleTapTimeoutRef.current);
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, [isOpen, media?.id, fallbackStage, effectiveUrl, triggerNextFallback, resetControlsTimeout, nativePlayerUnavailable]);

  // Clean up subtitle blob url on unmount
  useEffect(() => {
    return () => {
      if (customSubtitleUrl) {
        URL.revokeObjectURL(customSubtitleUrl);
      }
    };
  }, [customSubtitleUrl]);

  if (!isOpen || !media) return null;

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
      setIsPlaying(false);
    } else {
      videoRef.current.play().catch(() => {
        triggerNextFallback('play_gesture_error');
      });
      setIsPlaying(true);
    }
    resetControlsTimeout();
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
      if (videoRef.current.duration && !isNaN(videoRef.current.duration)) {
        setDuration(videoRef.current.duration);
      }
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = Number(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      setCurrentTime(time);
    }
    resetControlsTimeout();
  };

  const skipSeconds = (seconds: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(0, Math.min(duration, videoRef.current.currentTime + seconds));
    }
    resetControlsTimeout();
  };

  const changeSpeed = (speed: number) => {
    setPlaybackSpeed(speed);
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
    }
    resetControlsTimeout();
  };

  const cycleSpeed = () => {
    const currentIndex = PLAYBACK_SPEEDS.indexOf(playbackSpeed);
    const nextIndex = (currentIndex + 1) % PLAYBACK_SPEEDS.length;
    changeSpeed(PLAYBACK_SPEEDS[nextIndex]);
  };

  const formatTime = (secs: number) => {
    if (isNaN(secs) || secs < 0) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const toggleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  // Convert SRT subtitles into standard WebVTT format for native HTML5 <track>
  const convertSrtToVtt = (srtContent: string): string => {
    const vtt =
      'WEBVTT\n\n' +
      srtContent
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    return vtt;
  };

  const handleSubtitleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const rawText = event.target?.result as string;
      if (!rawText) return;

      if (customSubtitleUrl) {
        URL.revokeObjectURL(customSubtitleUrl);
      }

      const vttText = file.name.endsWith('.vtt') ? rawText : convertSrtToVtt(rawText);
      const blob = new Blob([vttText], { type: 'text/vtt' });
      const newUrl = URL.createObjectURL(blob);

      setCustomSubtitleUrl(newUrl);
      setCustomSubtitleName(file.name);
      setSubtitleTrack(file.name);
      setShowSettingsMenu(false);
    };
    reader.readAsText(file);
  };

  // Show Temporary Gestures HUD (Volume / Brightness)
  const triggerHud = (icon: 'volume' | 'brightness', text: string) => {
    setHudFeedback({ icon, text });
    if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    hudTimerRef.current = setTimeout(() => {
      setHudFeedback(null);
    }, 1200);
  };

  // Touch Handlers for Swipe Gestures & Double-Tap
  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1) return;
    touchStartXRef.current = e.touches[0].clientX;
    touchStartYRef.current = e.touches[0].clientY;
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1) return;
    const clientX = e.touches[0].clientX;
    const clientY = e.touches[0].clientY;
    const deltaY = touchStartYRef.current - clientY;
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const isLeftSide = clientX - rect.left < rect.width * 0.5;

    // Minimum swipe threshold
    if (Math.abs(deltaY) > 8) {
      if (isLeftSide) {
        // Adjust Brightness (0.2 to 1.5)
        const step = deltaY > 0 ? 0.02 : -0.02;
        setBrightness((prev) => {
          const next = Math.max(0.2, Math.min(1.5, parseFloat((prev + step).toFixed(2))));
          triggerHud('brightness', `%${Math.round((next / 1.5) * 100)}`);
          return next;
        });
      } else {
        // Adjust Volume (0.0 to 1.0)
        const step = deltaY > 0 ? 0.02 : -0.02;
        setVolume((prev) => {          const next = Math.max(0, Math.min(1.0, parseFloat((prev + step).toFixed(2))));
          if (videoRef.current) {
            videoRef.current.volume = next;
            videoRef.current.muted = next === 0;
            setIsMuted(next === 0);
          }
          triggerHud('volume', `%${Math.round(next * 100)}`);
          return next;
        });
      }
      touchStartYRef.current = clientY;
    }
  };

  const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const now = Date.now();
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const width = rect.width;

    // Check for double-tap (< 300ms)
    if (now - lastTapTimeRef.current < 300) {
      if (singleTapTimeoutRef.current) {
        clearTimeout(singleTapTimeoutRef.current);
      }
      // Double tap on left side -> Rewind 10s
      if (clickX < width * 0.45) {
        skipSeconds(-10);
        setRippleFeedback({ type: 'rewind', id: now });
        setTimeout(() => setRippleFeedback(null), 700);
      }
      // Double tap on right side -> Fast forward 10s
      else if (clickX > width * 0.55) {
        skipSeconds(10);
        setRippleFeedback({ type: 'forward', id: now });
        setTimeout(() => setRippleFeedback(null), 700);
      } else {
        togglePlay();
      }
      lastTapTimeRef.current = 0;
    } else {
      // Single Tap -> Toggle controls visibility
      lastTapTimeRef.current = now;
      singleTapTimeoutRef.current = setTimeout(() => {
        setShowControls((prev) => !prev);
        resetControlsTimeout();
      }, 250);
    }
  };

  const handleCopyStreamLink = () => {
    const link = rawUrl || media.streamUrl;
    if (link) {
      navigator.clipboard.writeText(link).then(() => {
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 2500);
      });
    }
  };

  const mediaTitle = media.title;
  const resolutionBadge = 'resolutionBadge' in media ? media.resolutionBadge : (media as MediaItem).resolution;
  const isLive = 'type' in media && media.type === 'live';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 backdrop-blur-xl p-2 sm:p-4 select-none">
      <div
        id="player-container"
        ref={containerRef}
        onMouseMove={resetControlsTimeout}
        onClick={handleContainerClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        className="relative w-full max-w-4xl bg-black rounded-3xl overflow-hidden shadow-2xl border border-white/10 flex flex-col aspect-video group cursor-pointer"
      >
        {/* 2- .mp4 / .mkv VOD içerikleri ve canlı yayınlar için crossOrigin="anonymous" ve playsInline nitelikleri */}
        <video
          ref={videoRef}
          key={`${media.id}-${fallbackStage}`}
          poster={media.poster}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={() => setTimeout(refreshMediaTracks, 0)}
          onEnded={() => setIsPlaying(false)}
          onError={(e) => {
            if (hlsRef.current || !e.currentTarget.currentSrc) return;
            const code = e.currentTarget.error?.code;
            triggerNextFallback(`html5_video_error_${code ?? 'x'}`);
          }}
          playsInline
          preload="auto"

          style={{ filter: `brightness(${brightness})` }}
          className="w-full h-full object-contain"
        >
          {customSubtitleUrl && subtitleTrack !== 'Kapalı' && (
            <track
              key={customSubtitleUrl}
              src={customSubtitleUrl}
              kind="subtitles"
              srcLang="tr"
              label={customSubtitleName || 'Altyazı'}
              default
            />
          )}
        </video>

        {/* Dynamic Fallback Notice Notification */}
        {fallbackNotice && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-2xl bg-[#00f0ff]/95 text-[#00363a] font-headline text-xs font-bold shadow-2xl flex items-center gap-2 animate-in fade-in slide-in-from-top duration-200">
            <Zap className="w-4 h-4 fill-current shrink-0" />
            <span>{fallbackNotice}</span>
          </div>
        )}

        {/* HUD Indicator (Volume / Brightness Gesture Feedback) */}
        {hudFeedback && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-40 px-5 py-3 rounded-2xl bg-black/80 backdrop-blur-md border border-white/10 text-white font-headline text-sm font-bold flex items-center gap-2.5 shadow-2xl pointer-events-none animate-in fade-in zoom-in-95 duration-150">
            {hudFeedback.icon === 'brightness' ? (
              <Sun className="w-6 h-6 text-[#00f0ff] animate-pulse" />
            ) : (
              <Volume2 className="w-6 h-6 text-[#4edea3] animate-pulse" />
            )}
            <div className="flex flex-col">
              <span className="text-[10px] text-[#b9cacb] uppercase">
                {hudFeedback.icon === 'brightness' ? 'Parlaklık' : 'Ses'}
              </span>
              <span className="text-base text-white">{hudFeedback.text}</span>
            </div>
          </div>
        )}

        {/* Double Tap Ripple Indicators */}
        {rippleFeedback && (
          <div
            className={`absolute top-1/2 -translate-y-1/2 z-30 flex flex-col items-center justify-center p-6 rounded-full bg-white/10 backdrop-blur-md pointer-events-none animate-ping duration-500 ${
              rippleFeedback.type === 'rewind' ? 'left-12' : 'right-12'
            }`}
          >
            {rippleFeedback.type === 'rewind' ? (
              <div className="flex items-center gap-1 text-[#00f0ff] font-headline font-bold text-sm">
                <Rewind className="w-8 h-8 fill-current" />
                <span>-10s</span>
              </div>
            ) : (
              <div className="flex items-center gap-1 text-[#00f0ff] font-headline font-bold text-sm">
                <span>+10s</span>
                <FastForward className="w-8 h-8 fill-current" />
              </div>
            )}
          </div>
        )}

        {/* 4- Tüm Denemeler Başarısız Olduğunda Gösterilen Bilgilendirme Ekranı */}
        {(playbackError || fallbackStage === 'failed') && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-x-4 top-14 z-40 p-4 rounded-2xl bg-[#1c1b1d]/95 backdrop-blur-xl border border-[#ffb4ab]/30 text-[#e5e1e4] text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-2xl"
          >
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-5 h-5 shrink-0 text-[#ffb4ab] mt-0.5" />
              <div className="flex flex-col">
                <span className="font-headline font-bold text-white text-sm">
                  Yayın Başlatılamadı
                </span>
                <span className="text-[11px] text-[#b9cacb] mt-0.5 max-w-md leading-relaxed">
                  {playbackError ||
                    'Akış açılamadı. Sunucu çevrimdışı olabilir veya video codec\'i tarayıcı tarafından desteklenmiyor.'}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              <button
                onClick={() => {
                  networkRetryCountRef.current = 0;
                  mediaRetryCountRef.current = 0;
                  setFallbackStage('proxy-hls');
                  setPlaybackError(null);                  triggerNotice('Proxy + HLS.js motoruyla yeniden deneniyor...');
                }}
                className="px-3 py-1.5 rounded-full bg-[#00f0ff] text-[#00363a] font-headline font-bold hover:brightness-110 text-xs cursor-pointer flex items-center gap-1.5 shadow-md"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                HLS ile Dene
              </button>

              <button
                onClick={() => {
                  setFallbackStage('proxy-native');
                  setPlaybackError(null);
                  triggerNotice('Proxy + HTML5 Native Video ile deneniyor...');
                }}
                className="px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-[#e5e1e4] font-medium text-xs cursor-pointer flex items-center gap-1"
              >
                <Tv className="w-3.5 h-3.5 text-[#4edea3]" />
                HTML5 Native
              </button>

              {rawUrl && (
                <button
                  onClick={() => {
                    setFallbackStage('direct');
                    setPlaybackError(null);
                    triggerNotice(
                      isHttpsEnvironment && isHttpUrl(rawUrl)
                        ? '🛡️ Güvenli HTTPS Proxy Tüneli başlatılıyor...'
                        : 'Doğrudan Ham Akış deneniyor...'
                    );
                  }}
                  className="px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-[#e5e1e4] font-medium text-xs cursor-pointer flex items-center gap-1"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-amber-300" />
                  Güvenli Tünel
                </button>
              )}

              <button
                onClick={() => {
                  setFallbackStage('sample');
                  setPlaybackError(null);
                  triggerNotice('Test akışı (Big Buck Bunny) başlatıldı.');
                }}
                className="px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 text-[#b9cacb] font-medium text-xs cursor-pointer"
              >
                Test Yayını
              </button>

              {rawUrl && (
                <button
                  onClick={handleCopyStreamLink}
                  className="px-2.5 py-1.5 rounded-full bg-white/5 hover:bg-white/10 text-[#b9cacb] text-xs cursor-pointer flex items-center gap-1"
                  title="Doğrudan Akış Bağlantısını Kopyala"
                >
                  <Copy className="w-3 h-3" />
                  <span>{copiedLink ? 'Kopyalandı!' : 'Linki Kopyala'}</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Top Overlay Bar */}
        <div
          onClick={(e) => e.stopPropagation()}
          className={`absolute top-0 inset-x-0 p-4 bg-gradient-to-b from-black/85 via-black/40 to-transparent flex items-center justify-between transition-opacity duration-300 z-30 ${
            showControls ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
          }`}
        >
          <div className="flex items-center gap-2.5 min-w-0 pr-4">
            <span className="px-2 py-0.5 rounded bg-[#00f0ff] text-[#00363a] font-headline text-[10px] font-bold shrink-0">
              {resolutionBadge || 'HD'}
            </span>
            <div className="flex flex-col min-w-0">
              <h3 className="font-headline text-sm font-bold text-white truncate">{mediaTitle}</h3>
              <span className="text-[11px] text-[#4edea3] flex items-center gap-1.5 font-mono truncate">
                <span className="w-1.5 h-1.5 rounded-full bg-[#4edea3] animate-pulse"></span>
                {isLive ? 'Canlı TV' : 'VOD / Dizi Bölümü'}
                <span className="text-[#849495]">•</span>
                <span className="text-[#b9cacb]">
                  {fallbackStage === 'proxy-hls'
                    ? '🛡️ Proxy + HLS.js'
                    : fallbackStage === 'proxy-native'
                    ? '🛡️ Proxy + HTML5'
                    : fallbackStage === 'direct'
                    ? isHttpsEnvironment && isHttpUrl(rawUrl)
                      ? '🛡️ Güvenli Tünel (CORS/SSL)'
                      : '⚡ Ham Akış (Direct)'
                    : fallbackStage === 'sample'
                    ? '🧪 Test Yayını'
                    : 'Bağlantı Hatası'}
                </span>
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Speed Pill Toggle */}
            <button
              onClick={cycleSpeed}
              className="h-8 px-2.5 rounded-full bg-black/60 hover:bg-black/90 text-[#00f0ff] font-mono text-xs font-bold flex items-center gap-1 border border-white/10 transition-colors cursor-pointer"
              title="Oynatma Hızını Değiştir"
            >
              <Gauge className="w-3.5 h-3.5" />
              <span>{playbackSpeed}x</span>
            </button>

            {/* Settings Drawer Button */}
            <button
              onClick={() => setShowSettingsMenu(!showSettingsMenu)}
              className="w-9 h-9 rounded-full bg-black/60 hover:bg-black/90 text-white flex items-center justify-center transition-all cursor-pointer border border-white/10"
              title="Gelişmiş Oynatıcı Ayarları"
            >
              <Sliders className="w-4 h-4" />
            </button>

            {/* Close Button */}
            <button
              onClick={handleClosePlayer}
              className="w-9 h-9 rounded-full bg-black/60 hover:bg-[#93000a]/60 text-white flex items-center justify-center transition-all cursor-pointer border border-white/10"
              title="Kapat"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Quality / Stream Engine / Subtitle / Speed / Brightness Drawer */}
        {showSettingsMenu && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute right-4 top-16 z-40 w-80 bg-[#1c1b1d]/95 backdrop-blur-2xl border border-white/10 rounded-2xl p-4 shadow-2xl text-xs flex flex-col gap-3 text-[#e5e1e4] max-h-[85%] overflow-y-auto no-scrollbar"
          >
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <span className="font-headline font-bold text-[#00f0ff] flex items-center gap-1.5">
                <Sliders className="w-4 h-4 text-[#00f0ff]" />
                Oynatıcı Ayarları
              </span>
              <button
                onClick={() => setShowSettingsMenu(false)}
                className="text-[#b9cacb] hover:text-white cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Stream Engine & Fallback Switcher */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] text-[#b9cacb] uppercase font-bold flex items-center gap-1">
                <Zap className="w-3 h-3 text-[#00f0ff]" />
                Akış Motoru &amp; Oynatma Modu
              </span>
              <div className="grid grid-cols-3 gap-1">
                <button
                  onClick={() => {
                    networkRetryCountRef.current = 0;
                    mediaRetryCountRef.current = 0;
                    setFallbackStage('proxy-hls');
                    setPlaybackError(null);
                    triggerNotice('Proxy + HLS.js motoru etkinleştirildi.');
                  }}
                  className={`py-2 px-1.5 rounded-xl text-[10px] font-bold flex flex-col items-center justify-center gap-1 transition-all cursor-pointer text-center ${
                    fallbackStage === 'proxy-hls'
                      ? 'bg-[#00f0ff] text-[#00363a] shadow-[0_0_10px_rgba(0,240,255,0.4)]'
                      : 'bg-[#201f21] hover:bg-[#2a2a2c] text-[#b9cacb]'
                  }`}
                  title="M3U8 Canlı Yayın ve HLS akışları için HLS.js motoru"
                >
                  <RefreshCw className="w-3.5 h-3.5 shrink-0" />
                  <span>HLS.js</span>
                </button>

                <button
                  onClick={() => {
                    setFallbackStage('proxy-native');
                    setPlaybackError(null);
                    triggerNotice('Proxy + HTML5 Native (206 Range) motoru etkinleştirildi.');
                  }}
                  className={`py-2 px-1.5 rounded-xl text-[10px] font-bold flex flex-col items-center justify-center gap-1 transition-all cursor-pointer text-center ${                    fallbackStage === 'proxy-native'
                      ? 'bg-[#00f0ff] text-[#00363a] shadow-[0_0_10px_rgba(0,240,255,0.4)]'
                      : 'bg-[#201f21] hover:bg-[#2a2a2c] text-[#b9cacb]'
                  }`}
                  title="MP4 / MKV VOD filmler ve doğrudan medya için HTML5 Oynatıcı"
                >
                  <Tv className="w-3.5 h-3.5 shrink-0 text-[#4edea3]" />
                  <span>HTML5 Native</span>
                </button>

                <button
                  onClick={() => {
                    setFallbackStage('direct');
                    setPlaybackError(null);
                    triggerNotice(
                      isHttpsEnvironment && isHttpUrl(rawUrl)
                        ? '🛡️ Güvenli HTTPS Proxy Tüneli devrede (Karma İçerik Korumalı).'
                        : 'Doğrudan Ham Akış URL devrede.'
                    );
                  }}
                  className={`py-2 px-1.5 rounded-xl text-[10px] font-bold flex flex-col items-center justify-center gap-1 transition-all cursor-pointer text-center ${
                    fallbackStage === 'direct'
                      ? 'bg-[#00f0ff] text-[#00363a] shadow-[0_0_10px_rgba(0,240,255,0.4)]'
                      : 'bg-[#201f21] hover:bg-[#2a2a2c] text-[#b9cacb]'
                  }`}
                  title="Doğrudan IPTV sunucu akışı veya Güvenli HTTPS Tüneli"
                >
                  <ShieldCheck className="w-3.5 h-3.5 shrink-0 text-amber-300" />
                  <span>{isHttpsEnvironment && isHttpUrl(rawUrl) ? 'Güvenli Tünel' : 'Ham Akış'}</span>
                </button>
              </div>
              <div className="flex items-center justify-between text-[10px] text-[#849495] px-1 mt-0.5">
                <span>
                  Motor:{' '}
                  {isHlsActive
                    ? 'hls.js (M3U8 / Live)'
                    : fallbackStage === 'proxy-native'
                    ? 'HTML5 Native (206 Range Proxy)'
                    : fallbackStage === 'direct'
                    ? isHttpsEnvironment && isHttpUrl(rawUrl)
                      ? 'Güvenli HTTPS Tüneli'
                      : 'HTML5 Direct Stream'
                    : 'HTML5 Video'}
                </span>
                <span className="text-[#4edea3]">Aktif</span>
              </div>
            </div>

            {/* HLS Levels / Quality Selection */}
            {hlsLevels.length > 0 && (
              <div className="flex flex-col gap-1 pt-1 border-t border-white/5">
                <span className="text-[10px] text-[#b9cacb] uppercase font-bold flex items-center gap-1">
                  <Tv className="w-3 h-3 text-[#4edea3]" />
                  HLS Kalite Seviyesi
                </span>
                <div className="grid grid-cols-2 gap-1 mt-1">
                  <button
                    onClick={() => {
                      if (hlsRef.current) hlsRef.current.currentLevel = -1;
                      setQuality('Otomatik');
                    }}
                    className={`px-2 py-1.5 rounded text-[11px] font-bold cursor-pointer transition-colors ${
                      quality === 'Otomatik'
                        ? 'bg-[#0566d9] text-white'
                        : 'bg-[#201f21] hover:bg-[#2a2a2c] text-[#e5e1e4]'
                    }`}
                  >
                    Otomatik (ABR)
                  </button>
                  {hlsLevels.map((lvl) => (
                    <button
                      key={lvl.id}
                      onClick={() => {
                        if (hlsRef.current) hlsRef.current.currentLevel = lvl.id;
                        setQuality(lvl.name);
                      }}
                      className={`px-2 py-1.5 rounded text-[11px] font-bold cursor-pointer transition-colors truncate ${
                        quality === lvl.name
                          ? 'bg-[#0566d9] text-white'
                          : 'bg-[#201f21] hover:bg-[#2a2a2c] text-[#e5e1e4]'
                      }`}
                    >
                      {lvl.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Playback Speed Setting */}
            <div className="pt-1 border-t border-white/5">
              <span className="text-[10px] text-[#b9cacb] uppercase font-bold flex items-center gap-1">
                <Gauge className="w-3 h-3 text-[#00f0ff]" />
                Oynatma Hızı
              </span>
              <div className="grid grid-cols-5 gap-1 mt-1">
                {PLAYBACK_SPEEDS.map((sp) => (
                  <button
                    key={sp}
                    onClick={() => changeSpeed(sp)}
                    className={`py-1.5 rounded text-[11px] font-bold font-mono transition-all cursor-pointer ${
                      playbackSpeed === sp
                        ? 'bg-[#00f0ff] text-[#00363a] shadow-[0_0_8px_rgba(0,240,255,0.4)]'
                        : 'bg-[#201f21] hover:bg-[#2a2a2c] text-[#e5e1e4]'
                    }`}
                  >
                    {sp}x
                  </button>
                ))}
              </div>
            </div>

            {/* Brightness Control in Menu */}
            <div className="flex flex-col gap-1 pt-1 border-t border-white/5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-[#b9cacb] uppercase font-bold flex items-center gap-1">
                  <Sun className="w-3 h-3 text-amber-300" />
                  Ekran Parlaklığı
                </span>
                <span className="text-[#00f0ff] font-mono font-bold">
                  %{Math.round((brightness / 1.5) * 100)}
                </span>
              </div>
              <input
                type="range"
                min="0.2"
                max="1.5"
                step="0.05"
                value={brightness}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setBrightness(val);
                }}
                className="w-full h-1.5 bg-[#353437] rounded appearance-none cursor-pointer"
              />
            </div>

            {/* Subtitle Section & File Upload */}
            <div className="flex flex-col gap-1.5 pt-1 border-t border-white/5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-[#b9cacb] uppercase font-bold flex items-center gap-1">
                  <Subtitles className="w-3 h-3 text-[#4edea3]" />
                  Altyazı (.SRT / .VTT)
                </span>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="text-[10px] text-[#00f0ff] hover:underline flex items-center gap-0.5 font-semibold cursor-pointer"
                >
                  <Upload className="w-3 h-3" />
                  Dosya Yükle
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".srt,.vtt,text/plain"
                  className="hidden"
                  onChange={handleSubtitleFileUpload}
                />
              </div>

              <div className="flex flex-col gap-1">
                <button onClick={() => selectSubtitleTrack(null)} className="px-2.5 py-1.5 rounded text-left text-[11px] bg-[#201f21]">Kapalı</button>
                {availableSubtitleTracks.map(t => (
                  <button key={t.id} onClick={() => selectSubtitleTrack(t.id)}
                    className={`px-2.5 py-1.5 rounded text-left text-[11px] ${subtitleTrack === t.name ? 'bg-[#0566d9] text-white' : 'bg-[#201f21]'}`}>
                    {t.name}
                  </button>
                ))}
                {customSubtitleName && (
                  <button onClick={() => setSubtitleTrack(customSubtitleName)} className="px-2.5 py-1.5 rounded text-left text-[11px] bg-[#201f21]">{customSubtitleName}</button>
                )}
                {availableSubtitleTracks.length === 0 && !customSubtitleName && <span className="text-[10px] text-[#b9cacb]">Oynatıcı altyazı kanalı bildirmedi.</span>}
              </div>
            </div>

            {/* Audio Track */}            <div className="flex flex-col gap-1 pt-1 border-t border-white/5">
              <span className="text-[10px] text-[#b9cacb] uppercase font-bold">Ses İzi</span>
              <div className="flex flex-col gap-1">
                {availableAudioTracks.map(t => (
                  <button key={t.id} onClick={() => selectAudioTrack(t.id)}
                    className={`px-2.5 py-1.5 rounded text-left text-[11px] ${audioTrack === t.name ? 'bg-[#0566d9] text-white' : 'bg-[#201f21]'}`}>
                    {t.name}
                  </button>
                ))}
                {availableAudioTracks.length === 0 && <span className="text-[10px] text-[#b9cacb]">Oynatıcı ses kanalı bildirmedi (varsayılan ses kullanılıyor).</span>}
                <button type="button" onClick={refreshMediaTracks} className="text-left text-[10px] text-[#00f0ff]">Kanalları yenile ({trackSource})</button>
              </div>
            </div>

            {/* Stream URL & Diagnostics */}
            <div className="pt-1 border-t border-white/5">
              <span className="text-[10px] text-[#849495] uppercase font-bold">Aktif Akış Bağlantısı</span>
              <span
                className="text-[10px] text-[#00f0ff] font-mono block truncate mt-0.5"
                title={effectiveUrl}
              >
                {effectiveUrl}
              </span>
            </div>
          </div>
        )}

        {/* Center Play/Pause Large Touch Indicator */}
        <div
          onClick={(e) => {
            e.stopPropagation();
            togglePlay();
          }}
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
        >
          {!isPlaying && !playbackError && fallbackStage !== 'failed' && (
            <div className="w-16 h-16 rounded-full bg-black/70 border border-white/20 flex items-center justify-center text-[#00f0ff] shadow-2xl backdrop-blur-md pointer-events-auto cursor-pointer hover:scale-105 active:scale-95 transition-transform">
              <Play className="w-8 h-8 fill-current ml-1" />
            </div>
          )}
        </div>

        {/* Bottom Control Bar */}
        <div
          onClick={(e) => e.stopPropagation()}
          className={`absolute bottom-0 inset-x-0 p-3 sm:p-4 bg-gradient-to-t from-black/90 via-black/60 to-transparent flex flex-col gap-2 transition-opacity duration-300 z-30 ${
            showControls ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
          }`}
        >
          {/* Scrubber progress slider */}
          {!isLive && (
            <div className="flex items-center gap-2 text-[11px] text-[#b9cacb] font-mono">
              <span className="w-10 text-right">{formatTime(currentTime)}</span>
              <input
                type="range"
                min="0"
                max={duration || 100}
                value={currentTime}
                onChange={handleSeek}
                className="flex-1 h-1.5 bg-[#353437] rounded-lg appearance-none cursor-pointer"
              />
              <span className="w-10">{formatTime(duration)}</span>
            </div>
          )}

          {/* Action Row */}
          <div className="flex items-center justify-between pt-1 flex-wrap gap-2">
            <div className="flex items-center gap-2 sm:gap-3">
              {/* Play / Pause button */}
              <button
                onClick={togglePlay}
                className="w-9 h-9 rounded-full bg-[#00f0ff] text-[#00363a] flex items-center justify-center shadow-[0_0_10px_rgba(0,240,255,0.4)] hover:brightness-110 active:scale-95 transition-all cursor-pointer"
              >
                {isPlaying ? (
                  <Pause className="w-4 h-4 text-[#00363a]" />
                ) : (
                  <Play className="w-4 h-4 fill-current ml-0.5" />
                )}
              </button>

              {!isLive && (
                <>
                  <button
                    onClick={() => skipSeconds(-10)}
                    className="text-white hover:text-[#00f0ff] cursor-pointer transition-colors p-1"
                    title="10s Geri"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => skipSeconds(10)}
                    className="text-white hover:text-[#00f0ff] cursor-pointer transition-colors p-1"
                    title="10s İleri"
                  >
                    <RotateCw className="w-4 h-4" />
                  </button>
                </>
              )}

              {/* Volume Slider */}
              <div className="flex items-center gap-1.5 ml-1">
                <button
                  onClick={() => {
                    const newMute = !isMuted;
                    setIsMuted(newMute);
                    if (videoRef.current) {
                      videoRef.current.muted = newMute;
                    }
                  }}
                  className="text-white hover:text-[#00f0ff] cursor-pointer p-1"
                  title="Sesi Aç/Kapat"
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="w-4 h-4 text-[#ffb4ab]" />
                  ) : (
                    <Volume2 className="w-4 h-4 text-white" />
                  )}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={isMuted ? 0 : volume}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setVolume(v);
                    setIsMuted(v === 0);
                    if (videoRef.current) {
                      videoRef.current.volume = v;
                      videoRef.current.muted = v === 0;
                    }
                  }}
                  className="w-14 sm:w-20 h-1 bg-[#353437] rounded appearance-none cursor-pointer"
                />
              </div>

              {/* Brightness Slider on bottom bar */}
              <div className="hidden sm:flex items-center gap-1.5 ml-1">
                <Sun className="w-4 h-4 text-amber-300 shrink-0" />
                <input
                  type="range"
                  min="0.2"
                  max="1.5"
                  step="0.05"
                  value={brightness}
                  onChange={(e) => setBrightness(Number(e.target.value))}
                  className="w-14 sm:w-16 h-1 bg-[#353437] rounded appearance-none cursor-pointer"
                  title="Parlaklık"
                />
              </div>
            </div>

            <div className="flex items-center gap-2 sm:gap-3">
              {/* Stream Mode Indicator Pill */}
              <button
                onClick={() => {
                  const nextStage: FallbackStage = fallbackStage === 'direct' ? 'proxy-hls' : 'direct';
                  setFallbackStage(nextStage);
                  triggerNotice(
                    nextStage === 'direct'
                      ? '⚡ Ham Akış URL\'sine geçildi.'
                      : '🛡️ Proxy Korumalı Akışa geçildi.'
                  );
                }}
                className={`hidden xs:flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold font-mono border cursor-pointer transition-colors ${
                  fallbackStage === 'direct'
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                    : 'bg-[#00f0ff]/10 text-[#00f0ff] border-[#00f0ff]/20'
                }`}
                title="Akış Modunu Değiştir"
              >
                {fallbackStage === 'direct' ? <Zap className="w-3 h-3 fill-current" /> : <ShieldCheck className="w-3 h-3" />}
                <span>{fallbackStage === 'direct' ? 'Ham URL' : 'Proxy'}</span>
              </button>

              {/* Speed Button */}              <button
                onClick={cycleSpeed}
                className="px-2 py-0.5 rounded-full bg-[#201f21] hover:bg-[#2a2a2c] text-[#00f0ff] font-mono text-xs font-bold border border-white/5 cursor-pointer"
                title="Hızı Değiştir"
              >
                {playbackSpeed}x
              </button>

              <span className="hidden sm:inline-block text-[11px] text-[#00f0ff] font-mono bg-[#00f0ff]/10 px-2 py-0.5 rounded border border-[#00f0ff]/20">
                {quality}
              </span>

              <button
                onClick={toggleFullscreen}
                className="text-white hover:text-[#00f0ff] cursor-pointer p-1"
                title="Tam Ekran"
              >
                <Maximize2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};