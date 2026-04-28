export type ActionItem = {
	icon?: string;
	iconSvg?: string;
	iconColor?: string;
	title: string;
	sub?: string;
	danger?: boolean;
	disabled?: boolean;
	onClick: () => void;
};
