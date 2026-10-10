import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Expand, Pause, Play, ZoomIn, ZoomOut } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import Guacamole from "guacamole-common-js";
import "@xterm/xterm/css/xterm.css";
import { parseAsciicast, type Asciicast } from "./asciicast";
import type { SessionLogRecord } from "./session-recording-api";

const SPEEDS = [0.5, 1, 2, 4];
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

// null zoom means fit to the panel.
function useZoom(onChange: () => void) {
  const zoomRef = useRef<number | null>(null);
  const [zoom, setZoomState] = useState<number | null>(null);
  const [scale, setScale] = useState(1);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const setZoom = useCallback((value: number | null) => {
    zoomRef.current = value === null ? null : clampZoom(value);
    setZoomState(zoomRef.current);
    onChangeRef.current();
  }, []);

  return { zoomRef, zoom, scale, setScale, setZoom };
}

function useCtrlWheelZoom(
  ref: RefObject<HTMLDivElement | null>,
  scaleRef: RefObject<number>,
  setZoom: (value: number) => void,
) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(scaleRef.current * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [ref, scaleRef, setZoom]);
}

function formatPosition(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function SeekBar({
  position,
  duration,
  onSeek,
}: {
  position: number;
  duration: number;
  onSeek: (position: number) => void;
}) {
  const { t } = useTranslation();
  const barRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const progress = duration > 0 ? Math.min(position / duration, 1) : 0;

  const seekFromPointer = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || duration <= 0) return;
    const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    onSeek(ratio * duration);
  };

  return (
    <div
      ref={barRef}
      role="slider"
      tabIndex={0}
      aria-label={t("player.timeline")}
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={position}
      className="group/seek relative h-3 w-full cursor-pointer touch-none outline-none"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        seekFromPointer(event.clientX);
      }}
      onPointerMove={(event) => {
        if (dragging) seekFromPointer(event.clientX);
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onSeek(Math.max(position - 5, 0));
        if (event.key === "ArrowRight")
          onSeek(Math.min(position + 5, duration));
      }}
    >
      <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-border transition-[height] group-hover/seek:h-1 group-focus-visible/seek:h-1">
        <div
          className="h-full bg-primary"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  );
}

const ICON_BUTTON =
  "flex size-6 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

function PlaybackControls({
  playing,
  position,
  duration,
  speed,
  scale,
  fitted,
  onToggle,
  onSeek,
  onSpeed,
  onZoom,
}: {
  playing: boolean;
  position: number;
  duration: number;
  speed: number;
  scale: number;
  fitted: boolean;
  onToggle: () => void;
  onSeek: (position: number) => void;
  onSpeed: (speed: number) => void;
  onZoom: (zoom: number | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="shrink-0 border-t border-border/60 bg-muted/20">
      <SeekBar position={position} duration={duration} onSeek={onSeek} />
      <div className="flex flex-wrap items-center gap-x-2 px-1 pb-1">
        <button
          type="button"
          onClick={onToggle}
          className={ICON_BUTTON}
          aria-label={playing ? t("player.pause") : t("player.play")}
        >
          {playing ? (
            <Pause className="size-3.5" />
          ) : (
            <Play className="size-3.5" />
          )}
        </button>
        <span className="flex-1 text-[10px] tabular-nums text-muted-foreground">
          {formatPosition(Math.min(position, duration))} /{" "}
          {formatPosition(duration)}
        </span>
        <div
          className="flex items-center"
          role="group"
          aria-label={t("player.zoom")}
        >
          <button
            type="button"
            onClick={() => onZoom(scale / 1.25)}
            disabled={scale <= MIN_ZOOM}
            className={ICON_BUTTON}
            aria-label={t("player.zoomOut")}
            title={t("player.zoomOut")}
          >
            <ZoomOut className="size-3.5" />
          </button>
          <span className="w-8 text-center text-[10px] tabular-nums text-muted-foreground">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => onZoom(scale * 1.25)}
            disabled={scale >= MAX_ZOOM}
            className={ICON_BUTTON}
            aria-label={t("player.zoomIn")}
            title={t("player.zoomIn")}
          >
            <ZoomIn className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onZoom(null)}
            aria-pressed={fitted}
            className={`${ICON_BUTTON} ${fitted ? "bg-muted text-foreground" : ""}`}
            aria-label={t("player.fit")}
            title={t("player.fit")}
          >
            <Expand className="size-3.5" />
          </button>
        </div>
        <div
          className="flex items-center"
          role="group"
          aria-label={t("player.speed")}
        >
          {SPEEDS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onSpeed(value)}
              aria-pressed={speed === value}
              className={
                speed === value
                  ? "h-5 px-1.5 text-[10px] tabular-nums bg-muted text-foreground"
                  : "h-5 px-1.5 text-[10px] tabular-nums text-muted-foreground/60 hover:text-foreground"
              }
            >
              {value}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function AsciicastPlayer({ blob }: { blob: Blob }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<() => void>(() => {});
  const scaleRef = useRef(1);
  const terminalRef = useRef<Terminal | null>(null);
  const recordingRef = useRef<Asciicast | null>(null);
  const positionRef = useRef(0);
  const eventIndexRef = useRef(0);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const { zoomRef, zoom, scale, setScale, setZoom } = useZoom(() =>
    fitRef.current(),
  );
  useCtrlWheelZoom(containerRef, scaleRef, setZoom);

  const renderAt = useCallback((nextPosition: number) => {
    const terminal = terminalRef.current;
    const recording = recordingRef.current;
    if (!terminal || !recording) return;
    if (nextPosition < positionRef.current) {
      terminal.reset();
      terminal.resize(recording.width, recording.height);
      eventIndexRef.current = 0;
    }
    while (eventIndexRef.current < recording.events.length) {
      const [time, type, data] = recording.events[eventIndexRef.current];
      if (time > nextPosition) break;
      if (type === "o") terminal.write(data);
      if (type === "r") {
        const [cols, rows] = data.split("x").map(Number);
        if (cols > 0 && rows > 0) terminal.resize(cols, rows);
      }
      eventIndexRef.current++;
    }
    positionRef.current = nextPosition;
    setPosition(nextPosition);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const sizer = sizerRef.current;
    const screen = screenRef.current;
    if (!container || !sizer || !screen) return;
    const terminal = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      convertEol: false,
      fontSize: 12,
      theme: { background: "#09090b" },
    });
    terminal.open(screen);
    terminalRef.current = terminal;
    // The recording keeps its own size, scaled to fit the panel or to the chosen zoom.
    const fit = () => {
      const width = screen.offsetWidth;
      const height = screen.offsetHeight;
      if (!width || !height) return;
      const next =
        zoomRef.current ??
        Math.min(
          1,
          (container.clientWidth - 16) / width,
          (container.clientHeight - 16) / height,
        );
      screen.style.transform = `scale(${next})`;
      sizer.style.width = `${width * next}px`;
      sizer.style.height = `${height * next}px`;
      scaleRef.current = next;
      setScale(next);
    };
    fitRef.current = fit;
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    observer.observe(screen);
    const resizeListener = terminal.onResize(() => requestAnimationFrame(fit));

    blob
      .text()
      .then((source) => {
        const recording = parseAsciicast(source);
        recordingRef.current = recording;
        setDuration(recording.duration);
        terminal.resize(recording.width, recording.height);
        renderAt(0);
      })
      .catch((reason) => setError(getErrorMessage(reason, String(reason))));

    return () => {
      observer.disconnect();
      resizeListener.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [blob, renderAt, setScale, zoomRef]);

  useEffect(() => {
    if (!playing || !recordingRef.current) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const next = Math.min(
        duration,
        positionRef.current + ((now - previous) / 1000) * speed,
      );
      previous = now;
      renderAt(next);
      if (next >= duration) setPlaying(false);
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [duration, playing, renderAt, speed]);

  if (error) return <div className="p-4 text-xs text-destructive">{error}</div>;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div
        ref={containerRef}
        className={`min-h-0 min-w-0 flex-1 bg-[#09090b] p-2 ${zoom === null ? "overflow-hidden" : "overflow-auto"}`}
      >
        <div ref={sizerRef} className="overflow-hidden">
          <div ref={screenRef} className="w-max origin-top-left" />
        </div>
      </div>
      <PlaybackControls
        playing={playing}
        position={position}
        duration={duration}
        speed={speed}
        scale={scale}
        fitted={zoom === null}
        onToggle={() => {
          if (!playing && position >= duration) renderAt(0);
          setPlaying((value) => !value);
        }}
        onSeek={renderAt}
        onSpeed={setSpeed}
        onZoom={setZoom}
      />
    </div>
  );
}

function GuacamolePlayer({ blob }: { blob: Blob }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const recordingRef = useRef<Guacamole.SessionRecording | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const scaleRef = useRef(1);
  const positionRef = useRef(0);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const { zoomRef, zoom, scale, setScale, setZoom } = useZoom(() =>
    fitRef.current(),
  );
  useCtrlWheelZoom(containerRef, scaleRef, setZoom);

  useEffect(() => {
    if (!containerRef.current) return;
    const recording = new Guacamole.SessionRecording(blob, 100);
    recordingRef.current = recording;
    const display = recording.getDisplay();
    const element = display.getElement();
    containerRef.current.replaceChildren(element);
    const fit = () => {
      const width = display.getWidth();
      if (width && containerRef.current) {
        const next =
          zoomRef.current ?? containerRef.current.clientWidth / width;
        display.scale(next);
        scaleRef.current = next;
        setScale(next);
      }
    };
    fitRef.current = fit;
    const observer = new ResizeObserver(fit);
    observer.observe(containerRef.current);
    recording.onload = () => {
      setDuration(recording.getDuration() / 1000);
      fit();
    };
    recording.onprogress = (nextDuration) => setDuration(nextDuration / 1000);
    recording.onseek = (nextPosition) => {
      positionRef.current = nextPosition / 1000;
      setPosition(positionRef.current);
    };
    recording.onerror = setError;

    return () => {
      observer.disconnect();
      recording.abort();
      recordingRef.current = null;
    };
  }, [blob, setScale, zoomRef]);

  useEffect(() => {
    const recording = recordingRef.current;
    if (!recording || !playing) return;
    recording.pause();
    let previous = performance.now();
    let nextPosition = positionRef.current;
    const interval = window.setInterval(() => {
      const now = performance.now();
      nextPosition = Math.min(
        duration,
        nextPosition + ((now - previous) / 1000) * speed,
      );
      previous = now;
      recording.seek(nextPosition * 1000);
      if (nextPosition >= duration) setPlaying(false);
    }, 100);
    return () => clearInterval(interval);
  }, [duration, playing, speed]);

  if (error) return <div className="p-4 text-xs text-destructive">{error}</div>;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div
        ref={containerRef}
        className={`min-h-0 flex-1 bg-black ${zoom === null ? "overflow-hidden" : "overflow-auto"}`}
      />
      <PlaybackControls
        playing={playing}
        position={position}
        duration={duration}
        speed={speed}
        scale={scale}
        fitted={zoom === null}
        onToggle={() => {
          const recording = recordingRef.current;
          if (!recording) return;
          if (!playing && position >= duration) recording.seek(0);
          setPlaying((value) => !value);
        }}
        onSeek={(nextPosition) => {
          recordingRef.current?.seek(nextPosition * 1000);
          positionRef.current = nextPosition;
          setPosition(nextPosition);
        }}
        onSpeed={setSpeed}
        onZoom={setZoom}
      />
    </div>
  );
}

export function SessionRecordingPlayer({
  log,
  blob,
}: {
  log: SessionLogRecord;
  blob: Blob;
}) {
  return log.format === "guacamole" ? (
    <GuacamolePlayer blob={blob} />
  ) : (
    <AsciicastPlayer blob={blob} />
  );
}
