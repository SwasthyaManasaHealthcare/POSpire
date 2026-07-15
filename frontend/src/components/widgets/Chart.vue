<template>
	<div class="widget-chart">
		<div v-if="!hasData" class="widget-chart__empty">{{ emptyText || __("No data available") }}</div>
		<component :is="chartComponent" v-else :data="chartData" :options="chartOptions" />
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

		const hasData = computed(
			() => props.values.some((v) => Number(v) > 0) && props.labels.length > 0,
		);

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

		const chartOptions = computed(() => ({
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: isRadial.value, position: "bottom" },
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

		return { hasData, chartComponent, chartData, chartOptions };
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
