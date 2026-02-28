import { useCallback, useRef, useState } from 'react';

interface UseLongPressOptions {
    threshold?: number;
}

export function useLongPress(
    callback: (e: React.MouseEvent | React.TouchEvent) => void,
    { threshold = 500 }: UseLongPressOptions = {}
) {
    const [isLongPressTriggered, setIsLongPressTriggered] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startPosRef = useRef<{ x: number; y: number } | null>(null);
    const isLongPressActiveRef = useRef(false);

    const start = useCallback(
        (e: React.MouseEvent | React.TouchEvent) => {
            // Only handle primary click
            if ('button' in e && e.button !== 0) return;

            const pos = 'touches' in e ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY };
            startPosRef.current = pos;
            setIsLongPressTriggered(false);
            isLongPressActiveRef.current = false;

            timerRef.current = setTimeout(() => {
                callback(e);
                setIsLongPressTriggered(true);
                isLongPressActiveRef.current = true;
                timerRef.current = null;
            }, threshold);
        },
        [callback, threshold]
    );

    const cancel = useCallback(
        () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            startPosRef.current = null;

            // We keep isLongPressTriggered as true for the subsequent onClick check
            // but we might want to clear it after a short delay to ensure next clicks work
            setTimeout(() => {
                setIsLongPressTriggered(false);
                isLongPressActiveRef.current = false;
            }, 10);
        },
        []
    );

    const move = useCallback(
        (e: React.MouseEvent | React.TouchEvent) => {
            if (!startPosRef.current || !timerRef.current) return;

            const pos = 'touches' in e ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY };
            const dx = Math.abs(pos.x - startPosRef.current.x);
            const dy = Math.abs(pos.y - startPosRef.current.y);

            // If moved more than 10px, cancel the long press (end user is likely scrolling)
            if (dx > 10 || dy > 10) {
                cancel();
            }
        },
        [cancel]
    );

    return {
        onMouseDown: start,
        onTouchStart: start,
        onMouseUp: cancel,
        onMouseLeave: cancel,
        onTouchEnd: cancel,
        onMouseMove: move,
        onTouchMove: move,
        // Helper to check if a long press just happened (use in onClick)
        isLongPressTriggered,
        style: {
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTouchCallout: 'none', // Prevent default context menu on mobile
        } as React.CSSProperties,
    };
}
