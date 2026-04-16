/** Global chart preferences — shared across all chart instances */

export type ChartType = 'line' | 'bar' | 'scatter';

class ChartPrefs {
    type: ChartType = $state('line');

    cycle() {
        const types: ChartType[] = ['line', 'bar', 'scatter'];
        const idx = types.indexOf(this.type);
        this.type = types[(idx + 1) % types.length];
    }
}

export const chartPrefs = new ChartPrefs();
