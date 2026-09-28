import { Image } from 'expo-image';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, type } from '../theme';

export interface PhotoThumbProps {
  uri: string | null | undefined;
  size?: number;
  /** Width / height; defaults to square. */
  aspectRatio?: number;
  selected?: boolean;
  onPress?: () => void;
  accessibilityLabel: string;
  /** Small caption over the bottom edge (e.g. a reading). */
  caption?: string;
}

/**
 * The media library's object API ids are `ph://…` on iOS, which expo-image loads directly;
 * a bare PHAsset identifier gets the scheme added.
 */
export function displayUri(uri: string): string {
  if (Platform.OS === 'ios' && !uri.includes('://')) return `ph://${uri}`;
  return uri;
}

export function PhotoThumb({ uri, size = 72, aspectRatio = 1, selected = false, onPress, accessibilityLabel, caption }: PhotoThumbProps) {
  const [failed, setFailed] = useState(false);
  const box = { width: size * aspectRatio, height: size };
  const body =
    uri && !failed ? (
      <Image
        source={{ uri: displayUri(uri) }}
        style={[styles.image, box]}
        contentFit="cover"
        transition={120}
        recyclingKey={uri}
        cachePolicy="memory"
        onError={() => setFailed(true)}
        accessible={false}
      />
    ) : (
      <View style={[styles.image, styles.placeholder, box]}>
        <Text style={styles.placeholderText}>{uri ? 'Photo unavailable' : 'No photo'}</Text>
      </View>
    );

  const content = (
    <View style={[styles.frame, selected && styles.selected]}>
      {body}
      {caption ? (
        <View style={styles.caption}>
          <Text style={styles.captionText} numberOfLines={1}>
            {caption}
          </Text>
        </View>
      ) : null}
    </View>
  );

  if (!onPress) {
    return (
      <View accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      style={({ pressed }) => pressed && styles.pressed}>
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: radius.md, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
  selected: { borderColor: colors.accent },
  pressed: { opacity: 0.75 },
  image: { backgroundColor: colors.surfaceMuted },
  placeholder: { alignItems: 'center', justifyContent: 'center', padding: 4 },
  placeholderText: { ...type.small, color: colors.textSubtle, textAlign: 'center' },
  caption: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.overlay, paddingVertical: 2 },
  captionText: { ...type.small, color: '#FFFFFF', textAlign: 'center' },
});
