<template>
	<div class="widget-chart">
		<div v-if="!hasData" class="widget-chart__empty">{{ emptyText || __("No data available") }}</div>
		<component
			:is="chartComponent"
			v-else
			:data="chartData"
			:options="chartOptions"
			:plugins="chartPlugins"
		/>
	</div>
</template>

<script>
import { computed } from "vue";
import { Line, Bar, Doughnut } from "vue-chartjs";
import {
	Chart as ChartJS,
	Title,
	Tooltip,
	Legend,
	LineElement,
	BarElement,
	PointElement,
	CategoryScale,
	LinearScale,
	ArcElement,
	Filler,
} from "chart.js";
import { PRIMARY, CATEGORICAL } from "./palette";

ChartJS.register(
	Title,
	Tooltip,
	Legend,
	LineElement,
	BarElement,
	PointElement,
	CategoryScale,
	LinearScale,
	ArcElement,
	Filler,
);

export default {
	name: "WidgetChart",
	props: {
		variant: { type: String, default: "line" },
		labels: { type: Array, default: () => [] },
		values: { type: Array, default: () => [] },
		colors: { type: [Array, String], default: () => CATEGORICAL },
		valueFormat: { type: Function, default: (v) => v },
		emptyText: { type: String, default: "" },
	},
	setup(props) {
		const isRadial = computed(() => props.variant === "donut");

		const hasData = computed(() => {
			if (!props.labels.length) return false;
			// Radial charts need a positive slice; axis charts still draw a flat
			// baseline when every value is zero, matching the prior dashboard.
			if (isRadial.value) return props.values.some((v) => Number(v) > 0);
			return true;
		});

		const chartComponent = computed(() => {
			if (props.variant === "bar") return Bar;
			if (props.variant === "donut") return Doughnut;
			return Line;
		});

		const chartData = computed(() => {
			if (isRadial.value) {
				const palette = Array.isArray(props.colors) ? props.colors : CATEGORICAL;
				return {
					labels: props.labels,
					datasets: [
						{
							data: props.values,
							backgroundColor: props.labels.map((_, i) => palette[i % palette.length]),
							borderWidth: 0,
						},
					],
				};
			}
			const single = typeof props.colors === "string" ? props.colors : PRIMARY;
			return {
				labels: props.labels,
				datasets: [
					{
						data: props.values,
						borderColor: single,
						backgroundColor: props.variant === "area" ? `${single}22` : single,
						fill: props.variant === "area",
						tension: 0.4,
						pointRadius: 3,
						borderRadius: props.variant === "bar" ? 6 : 0,
					},
				],
			};
		});

		// Draws a "Total <sum>" label in the centre of a doughnut, matching the
		// original payment-distribution donut.
		const centerTotalPlugin = {
			id: "donutCenterTotal",
			afterDatasetsDraw(chart) {
				if (props.variant !== "donut") return;
				const { ctx, chartArea } = chart;
				if (!chartArea) return;
				const total = props.values.reduce((sum, v) => sum + (Number(v) || 0), 0);
				const cx = (chartArea.left + chartArea.right) / 2;
				const cy = (chartArea.top + chartArea.bottom) / 2;
				ctx.save();
				ctx.textAlign = "center";
				ctx.textBaseline = "middle";
				ctx.fillStyle = "#64748b";
				ctx.font = "600 11px sans-serif";
				ctx.fillText(__("Total"), cx, cy - 10);
				ctx.fillStyle = "#0f172a";
				ctx.font = "700 17px sans-serif";
				ctx.fillText(props.valueFormat(total), cx, cy + 9);
				ctx.restore();
			},
		};

		const chartPlugins = computed(() => (isRadial.value ? [centerTotalPlugin] : []));

		const chartOptions = computed(() => ({
			responsive: true,
			maintainAspectRatio: false,
			layout: isRadial.value ? { padding: { bottom: 4 } } : {},
			plugins: {
				legend: {
					display: isRadial.value,
					position: "bottom",
					labels: isRadial.value
						? {
								usePointStyle: true,
								boxWidth: 8,
								generateLabels: (chart) => {
									const dataset = chart.data.datasets[0] || { data: [], backgroundColor: [] };
									return chart.data.labels.map((label, i) => ({
										text: `${label}  ${props.valueFormat(dataset.data[i])}`,
										fillStyle: dataset.backgroundColor[i],
										strokeStyle: dataset.backgroundColor[i],
										index: i,
									}));
								},
							}
						: {},
				},
				tooltip: {
					callbacks: {
						label: (ctx) => {
							const raw = isRadial.value ? ctx.parsed : ctx.parsed.y;
							return ` ${props.valueFormat(raw)}`;
						},
					},
				},
			},
			scales: isRadial.value
				? {}
				: {
						y: { ticks: { callback: (v) => props.valueFormat(v) }, grid: { color: "#e2e8f0" } },
						x: { grid: { display: false } },
					},
		}));

		return { hasData, chartComponent, chartData, chartOptions, chartPlugins };
	},
};
</script>

<style scoped>
.widget-chart {
	height: 320px;
	position: relative;
}
.widget-chart__empty {
	height: 100%;
	display: flex;
	align-items: center;
	justify-content: center;
	color: #64748b;
	font-size: 0.875rem;
	font-weight: 500;
}
</style>
