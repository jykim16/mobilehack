import { StyleSheet, Text, View } from 'react-native';

import { RetailerLogo } from '@/components/product-bits';
import { Spacing, Type, useThemedStyles, type Palette } from '@/constants/theme';

export function RetailerHeader({ retailer, retailerName, detail }: { retailer: string; retailerName: string; detail: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.retailer}>
      <RetailerLogo retailer={retailer} retailerName={retailerName} size={36} />
      <View>
        <Text style={styles.name}>{retailerName}</Text>
        {detail.length > 0 && <Text style={styles.detail}>{detail}</Text>}
      </View>
    </View>
  );
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  retailer: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  name: { ...Type.headline, color: Colors.text },
  detail: { ...Type.secondary, color: Colors.textSecondary },
});
