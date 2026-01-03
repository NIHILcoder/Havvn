/**
 * Speed Graph Component
 * 
 * Real-time visualization of download/upload speeds over time.
 */

import React, { useEffect, useRef, useState } from 'react';
import './SpeedGraph.css';

interface SpeedDataPoint {
    timestamp: number;
    download: number;
    upload: number;
}

interface SpeedGraphProps {
    downloadSpeed: number;
    uploadSpeed: number;
    historyLength?: number; // Number of data points to keep (default: 60)
    updateInterval?: number; // Update interval in ms (default: 1000)
    height?: number;
}

const formatSpeed = (bytes: number): string => {
    if (bytes === 0) return '0 B/s';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

export const SpeedGraph: React.FC<SpeedGraphProps> = ({
    downloadSpeed,
    uploadSpeed,
    historyLength = 60,
    updateInterval = 1000,
    height = 120,
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [history, setHistory] = useState<SpeedDataPoint[]>([]);

    // Add new data point on each update
    useEffect(() => {
        const interval = setInterval(() => {
            setHistory(prev => {
                const newPoint: SpeedDataPoint = {
                    timestamp: Date.now(),
                    download: downloadSpeed,
                    upload: uploadSpeed,
                };
                const updated = [...prev, newPoint];
                // Keep only the last N points
                return updated.slice(-historyLength);
            });
        }, updateInterval);

        return () => clearInterval(interval);
    }, [downloadSpeed, uploadSpeed, historyLength, updateInterval]);

    // Draw the graph
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);

        const width = rect.width;
        const graphHeight = rect.height;
        const padding = { top: 10, bottom: 20, left: 55, right: 10 };
        const graphWidth = width - padding.left - padding.right;
        const drawHeight = graphHeight - padding.top - padding.bottom;

        // Clear canvas
        ctx.clearRect(0, 0, width, graphHeight);

        // Check if light theme
        const isLightTheme = document.documentElement.getAttribute('data-theme') === 'light';
        const gridColor = isLightTheme ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.1)';
        const labelColor = isLightTheme ? 'rgba(0, 0, 0, 0.5)' : 'rgba(255, 255, 255, 0.5)';

        // Find max value for scaling
        const allSpeeds = history.length > 0 ? history.flatMap(p => [p.download, p.upload]) : [0];
        const maxSpeed = Math.max(...allSpeeds, 1024); // Minimum 1 KB/s scale
        const roundedMax = Math.ceil(maxSpeed / 1024) * 1024; // Round up to nearest KB

        // Draw grid
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;

        // Horizontal grid lines
        for (let i = 0; i <= 4; i++) {
            const y = padding.top + (drawHeight * i) / 4;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(width - padding.right, y);
            ctx.stroke();

            // Speed labels
            const speed = roundedMax * (1 - i / 4);
            ctx.fillStyle = labelColor;
            ctx.font = '10px system-ui';
            ctx.textAlign = 'right';
            ctx.fillText(formatSpeed(speed), padding.left - 5, y + 3);
        }

        // Draw lines only if we have data
        if (history.length < 2) {
            // Draw "No data" message
            ctx.fillStyle = labelColor;
            ctx.font = '12px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText('Сбор данных...', width / 2, graphHeight / 2);
            return;
        }

        const drawLine = (data: number[], color: string) => {
            if (data.length < 2) return;

            ctx.beginPath();
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            data.forEach((value, index) => {
                const x = padding.left + (index / (historyLength - 1)) * graphWidth;
                const y = padding.top + drawHeight - (value / roundedMax) * drawHeight;

                if (index === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            });

            ctx.stroke();

            // Fill area under line
            const lastX = padding.left + ((data.length - 1) / (historyLength - 1)) * graphWidth;
            ctx.lineTo(lastX, padding.top + drawHeight);
            ctx.lineTo(padding.left, padding.top + drawHeight);
            ctx.closePath();
            ctx.fillStyle = color.replace('rgb', 'rgba').replace(')', ', 0.15)');
            ctx.fill();
        };

        // Draw upload first (behind)
        drawLine(history.map(p => p.upload), 'rgb(251, 191, 36)');
        // Draw download on top
        drawLine(history.map(p => p.download), 'rgb(74, 222, 128)');

    }, [history, historyLength]);

    return (
        <div className="speed-graph expanded">
            <div className="speed-graph-header">
                <div className="speed-graph-stats">
                    <div className="speed-stat download">
                        <span className="speed-dot download" />
                        <span className="speed-label">↓</span>
                        <span className="speed-value">{formatSpeed(downloadSpeed)}</span>
                    </div>
                    <div className="speed-stat upload">
                        <span className="speed-dot upload" />
                        <span className="speed-label">↑</span>
                        <span className="speed-value">{formatSpeed(uploadSpeed)}</span>
                    </div>
                </div>
                <div className="speed-graph-legend-inline">
                    <span className="legend-item download">
                        <span className="legend-dot" /> Загрузка
                    </span>
                    <span className="legend-item upload">
                        <span className="legend-dot" /> Раздача
                    </span>
                </div>
            </div>

            <div className="speed-graph-canvas-container" style={{ height }}>
                <canvas ref={canvasRef} className="speed-graph-canvas" />
            </div>
        </div>
    );
};

export default SpeedGraph;

