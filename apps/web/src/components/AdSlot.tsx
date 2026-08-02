import { useEffect, useState } from "react";
import { adsFor, BANNER_ADS, RECT_ADS, type AdVariant } from "../lib/ads";

interface Props {
  variant: AdVariant;
  /** 切り替えの間隔（ミリ秒） */
  intervalMs?: number;
}

/**
 * 表示するたびに続きから始めるためのしおり。
 * コンポーネントの外に置くことで、タブを押すたび・開き直すたびに次の素材へ進み、
 * 登録した素材が一巡するように出る。開始位置は毎回の読み込みでばらす。
 */
const cursors: Record<AdVariant, number> = {
  rect: Math.floor(Math.random() * RECT_ADS.length),
  banner: Math.floor(Math.random() * BANNER_ADS.length),
};

/**
 * パネル本文の下に出す広告枠。
 * 一定時間ごとに次の素材へ切り替え、表示中の素材の計測用ビーコンも合わせて読み込む。
 */
export default function AdSlot({ variant, intervalMs = 10_000 }: Props) {
  const pool = adsFor(variant);

  const [index, setIndex] = useState(() => {
    if (pool.length === 0) return 0;
    const start = cursors[variant] % pool.length;
    cursors[variant] = (start + 1) % pool.length;
    return start;
  });

  useEffect(() => {
    if (pool.length < 2) return;
    const timer = window.setInterval(() => {
      setIndex((prev) => {
        const next = (prev + 1) % pool.length;
        cursors[variant] = (next + 1) % pool.length;
        return next;
      });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [pool.length, intervalMs, variant]);

  const ad = pool[index];
  if (!ad) return null;

  return (
    <div className={`ad-slot ad-slot-${variant}`}>
      <span className="ad-slot-label">広告</span>
      <a className="ad-slot-link" href={ad.href} target="_blank" rel="nofollow noopener noreferrer">
        {ad.img ? (
          <img
            key={ad.id}
            src={ad.img}
            width={ad.w}
            height={ad.h}
            alt={`${ad.sponsor}の広告`}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span className="ad-slot-text">{ad.text}</span>
        )}
      </a>
      {/* 表示計測用。素材と対で読み込む必要がある */}
      <img className="ad-slot-beacon" key={`${ad.id}-b`} src={ad.beacon} width={1} height={1} alt="" aria-hidden="true" />
    </div>
  );
}
