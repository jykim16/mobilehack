import Svg, { Circle, Path } from 'react-native-svg';

import { useColors } from '@/constants/theme';

/** The Cart mark: a shopping cart whose basket is a grin. Drawn on a 32 pt grid. */
export function CartLogo({ size = 24, color }: { size?: number; color?: string }) {
  const Colors = useColors();
  const fill = color ?? Colors.accent;
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Path d="M3.25 5H7L9 9.5" fill="none" stroke={fill} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
      <Path
        d="M8.25 9.25C8.25 8.56 8.81 8 9.5 8H29C29.69 8 30.25 8.56 30.25 9.25C30.25 15.74 25.33 20.5 19.25 20.5C13.17 20.5 8.25 15.74 8.25 9.25Z"
        fill={fill}
      />
      <Circle cx={13.75} cy={25.5} r={2.75} fill={fill} />
      <Circle cx={24.75} cy={25.5} r={2.75} fill={fill} />
    </Svg>
  );
}
