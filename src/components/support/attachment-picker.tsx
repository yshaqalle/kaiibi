import * as DocumentPicker from 'expo-document-picker';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { checkAttachment, MAX_ATTACHMENTS, type PendingAttachment } from '@/lib/support-attachments';

const theme = Colors.light;

// Last resort only. Both pickers report `mimeType`, but an Android content://
// URI whose provider declines to answer, and a web File the browser has no
// type for, both arrive null -- and uploadAttachment stores
// application/octet-stream for a null, which is what makes a downloaded PDF
// open as an unnamed binary instead of a document.
const TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
};

function contentTypeFor(reported: string | null | undefined, fileName: string): string | null {
  if (reported) return reported;
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  return TYPE_BY_EXTENSION[extension] ?? null;
}

// Pick, list, remove. Uploading happens on send, not here -- a file uploaded
// the moment it is picked is a file orphaned the moment someone changes their
// mind, and this bucket has no lifecycle rule to clean those up.
export function AttachmentPicker({
  files,
  onChange,
}: {
  files: PendingAttachment[];
  onChange: (files: PendingAttachment[]) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const accept = (next: PendingAttachment) => {
    const check = checkAttachment(files, next);
    if (!check.ok) {
      setProblem(check.message);
      return;
    }
    setProblem(null);
    setWarning(check.warn);
    onChange([...files, next]);
  };

  const addImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    const fileName = asset.fileName ?? 'screenshot.jpg';
    accept({
      uri: asset.uri,
      fileName,
      byteSize: asset.fileSize ?? 0,
      // An image picked from the library is an image whatever the picker says,
      // so this one ends at a type rather than at null.
      contentType: contentTypeFor(asset.mimeType, fileName) ?? 'image/jpeg',
    });
  };

  const addDocument = async () => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    accept({
      uri: asset.uri,
      fileName: asset.name,
      byteSize: asset.size ?? 0,
      contentType: contentTypeFor(asset.mimeType, asset.name),
    });
  };

  const remove = (index: number) => onChange(files.filter((_, i) => i !== index));

  return (
    <View>
      <View style={styles.actions}>
        <Pressable onPress={addImage} style={styles.action} accessibilityRole="button">
          <Text style={styles.actionText}>Add a screenshot</Text>
        </Pressable>
        <Pressable onPress={addDocument} style={styles.action} accessibilityRole="button">
          <Text style={styles.actionText}>Add a file</Text>
        </Pressable>
      </View>

      {files.map((file, index) => (
        <View key={`${file.uri}-${index}`} style={styles.row}>
          {file.contentType?.startsWith('image/') ? (
            <Image source={{ uri: file.uri }} style={styles.thumb} contentFit="cover" />
          ) : (
            <View style={styles.thumb}>
              <Text style={styles.thumbGlyph}>📄</Text>
            </View>
          )}
          <View style={styles.rowText}>
            <Text style={styles.fileName} numberOfLines={1}>
              {file.fileName}
            </Text>
            <Text style={styles.fileSize}>{(file.byteSize / 1024 / 1024).toFixed(1)} MB</Text>
          </View>
          <Pressable
            onPress={() => remove(index)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${file.fileName}`}
          >
            <Text style={styles.remove}>Remove</Text>
          </Pressable>
        </View>
      ))}

      <Text style={styles.hint}>
        {files.length} of {MAX_ATTACHMENTS} files. Screenshots, photos and PDFs.
      </Text>

      {warning && (
        <Caveat tone="context" onDismiss={() => setWarning(null)}>
          {warning}
        </Caveat>
      )}
      {problem && (
        <Caveat tone="wrong" action={{ label: 'OK', onPress: () => setProblem(null) }}>
          {problem}
        </Caveat>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 8 },
  action: {
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 999,
    paddingVertical: 9,
    paddingHorizontal: 15,
  },
  actionText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 12,
    padding: 9,
    marginTop: 9,
  },
  thumb: {
    width: 40,
    height: 40,
    borderRadius: 9,
    backgroundColor: theme.bentoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbGlyph: { fontSize: 17 },
  rowText: { flex: 1, minWidth: 0 },
  fileName: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk },
  fileSize: { fontSize: 11, color: theme.bentoMuted2 },
  remove: { fontSize: 11.5, fontWeight: '800', color: theme.bentoMuted },
  hint: { fontSize: 11, color: theme.bentoMuted2, marginTop: 8 },
});
