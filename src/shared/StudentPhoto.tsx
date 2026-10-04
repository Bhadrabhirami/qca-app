/**
 * StudentPhoto
 * ────────────
 * Displays a student's profile picture with full offline support.
 *
 * Flow:
 *  1. If no profile_image → show initials avatar immediately.
 *  2. Check Cache API for previously stored copy → show instantly (works offline).
 *  3. Not cached → fetch from server → store in cache → display.
 *  4. Fetch fails (offline, 404, etc.) → show initials avatar.
 *
 * The caller never has to think about URLs or caching.
 */

import React, { useEffect, useState } from 'react';
import { getCachedImageUrl, getAvatarUrl } from '../database/db';

interface Props {
  student: { name: string; profile_image?: string | null };
  size?: number;
  style?: React.CSSProperties;
}

export default function StudentPhoto({ student, size = 48, style = {} }: Props) {
  // Null guard — defensive for callers that may pass null student
  const safeName = student?.name ?? '?';
  const safeImage = student?.profile_image ?? null;
  const [src, setSrc] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    (async () => {
      const url = await getCachedImageUrl(safeImage);
      if (cancelled) return;
      if (url) {
        objectUrl = url;
        setSrc(url);
      }
      setReady(true);
    })();

    return () => {
      cancelled = true;
      // Revoke object URLs to avoid memory leaks.
      // We revoke on a slight delay so the img element has time to paint.
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl!), 10_000);
    };
  }, [student.profile_image]);

  const baseStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    objectFit: 'cover',
    flexShrink: 0,
    ...style,
  };

  // Show initials avatar while loading or if no photo
  if (!ready || !src) {
    const initials = student.name
      .split(' ')
      .map(w => w[0] ?? '')
      .slice(0, 2)
      .join('')
      .toUpperCase();
    const hue = student.name.charCodeAt(0) * 37 % 360;
    return (
      <div style={{
        ...baseStyle,
        backgroundColor: `hsl(${hue},40%,26%)`,
        border: `2px solid hsl(${hue},40%,36%)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: `hsl(${hue},60%,74%)`,
        fontWeight: 800,
        fontSize: size * 0.36,
        fontFamily: 'sans-serif',
      }}>
        {initials}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={student.name}
      style={baseStyle}
      onError={() => setSrc(null)} // fallback to avatar if object-url fails
    />
  );
}
