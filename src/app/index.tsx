import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ScrollViewInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChatComposer, COMPOSER_HEIGHT } from '@/components/chat-composer';
import { PillButton } from '@/components/pill-button';
import { ProductImage, RatingText } from '@/components/product-bits';
import { Colors, Radius, Spacing, Type, tabularNumbers } from '@/constants/theme';
import type { ChatMessage, ChatSuggestion } from '@/data/assistant-api';
import { useShop } from '@/data/shop-store';
import { formatPrice } from '@/lib/format';
import { useSession } from '@/lib/session';

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const { messages, assistantTyping, sendMessage, cartCount } = useShop();
  const session = useSession();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<ScrollViewInstance>(null);
  const canSend = draft.trim().length > 0 && !assistantTyping;

  const send = () => {
    if (!canSend) return;
    sendMessage(draft.trim());
    setDraft('');
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <View testID={`session-${session}`} style={[styles.header, { paddingTop: insets.top + Spacing.sm }]}>
        <Text style={styles.wordmark} accessibilityRole="header">
          cart
        </Text>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={[
          styles.messagesContent,
          { paddingBottom: COMPOSER_HEIGHT + Math.max(insets.bottom, Spacing.md) + Spacing.xxl },
        ]}
        keyboardDismissMode="interactive"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}>
        {messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}
        {assistantTyping && <Text style={styles.typing}>Thinking…</Text>}
      </ScrollView>

      <ChatComposer
        value={draft}
        onChangeText={setDraft}
        onSend={send}
        canSend={canSend}
        cartCount={cartCount}
        onOpenCart={() => router.push('/cart')}
        bottomInset={Math.max(insets.bottom, Spacing.md)}
      />
    </KeyboardAvoidingView>
  );
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <View style={styles.userBubble}>
        <Text style={styles.messageText}>{message.text}</Text>
      </View>
    );
  }
  return (
    <View style={styles.assistant}>
      <Text style={styles.messageText}>{message.text}</Text>
      {message.suggestions && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.suggestionScroller}
          contentContainerStyle={styles.suggestions}>
          {message.suggestions.map((suggestion) => (
            <Suggestion key={suggestion.url} suggestion={suggestion} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function Suggestion({ suggestion: { url, product, offer, rating } }: { suggestion: ChatSuggestion }) {
  const { items, addItem } = useShop();
  const inCart = items.some((item) => item.url === url);
  return (
    <View style={styles.suggestion}>
      <View style={styles.suggestionRow}>
        <ProductImage imageUrl={product.imageUrl} size={64} />
        <View style={styles.suggestionDetails}>
          <Text style={styles.suggestionTitle} numberOfLines={2}>
            {product.title}
          </Text>
          <RatingText rating={rating} />
        </View>
      </View>
      <View style={styles.suggestionFooter}>
        <View>
          <Text style={styles.suggestionPrice}>{formatPrice(offer.priceCents)}</Text>
          <Text style={styles.suggestionRetailer}>{offer.retailerName}</Text>
        </View>
        {inCart ? (
          <View style={styles.inCart}>
            <Ionicons name="checkmark" size={16} color={Colors.textSecondary} />
            <Text style={styles.inCartText}>In cart</Text>
          </View>
        ) : (
          <PillButton label="Add to cart" size="small" onPress={() => addItem(url)} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  header: { alignItems: 'center', paddingBottom: Spacing.md },
  wordmark: { fontSize: 24, lineHeight: 30, fontWeight: '700', letterSpacing: -1, color: Colors.accent },
  messages: { flex: 1 },
  messagesContent: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.xxl },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '82%',
    backgroundColor: Colors.control,
    borderRadius: 20,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 10,
  },
  assistant: { gap: Spacing.md },
  messageText: { ...Type.body, fontSize: 16, lineHeight: 23, color: Colors.text },
  typing: { ...Type.body, color: Colors.textSecondary },
  suggestionScroller: { marginHorizontal: -Spacing.lg },
  suggestions: { gap: Spacing.md, paddingHorizontal: Spacing.lg },
  suggestion: { width: 264, backgroundColor: Colors.surface, borderRadius: Radius.card, padding: Spacing.md, gap: Spacing.md },
  suggestionRow: { flexDirection: 'row', gap: Spacing.md },
  suggestionDetails: { flex: 1, gap: 2 },
  suggestionTitle: { ...Type.body, fontWeight: '600', color: Colors.text },
  suggestionFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  suggestionPrice: { ...Type.headline, ...tabularNumbers, color: Colors.text },
  suggestionRetailer: { ...Type.secondary, color: Colors.textSecondary },
  inCart: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, height: 36 },
  inCartText: { ...Type.body, color: Colors.textSecondary },
});
