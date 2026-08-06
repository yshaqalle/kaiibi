import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { updateShop, uploadShopLogo } from '@/lib/shops';
import { deleteImageByPublicUrl } from '@/lib/storage';

// "Tap your logo to change it", as one shared flow.
//
// The same fifteen lines lived in admin-sidebar.tsx and admin-tabs.web.tsx,
// and the Dashboard's header band was about to become a third copy. Pulled
// out here instead — an upload that crops to a square in two places and not
// the third is the kind of difference nobody notices until a logo comes out
// stretched.
//
// Gated on `settings.access`, the same permission as the Settings screen this
// shortcuts, and the one the shops/storage policies actually check.
export function useShopLogo() {
  const { shop, can, refreshShop } = useAuth();
  const [uploading, setUploading] = useState(false);
  const canEditLogo = can('settings.access');

  const editLogo = async () => {
    if (!shop || uploading || !canEditLogo) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      // Square, because every surface that shows it is a circle or a rounded
      // square — cropping here beats the logo being centre-cropped later.
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled) return;
    setUploading(true);
    // Captured before the upload, not read back off `shop` afterward: `shop`
    // itself doesn't change until refreshShop() below, but this is clearer
    // about which URL is "old" than relying on that.
    const oldLogoUrl = shop.logoUrl;
    try {
      const logoUrl = await uploadShopLogo(shop.id, result.assets[0].uri);
      await updateShop(shop.id, { logoUrl });
      await refreshShop();
      // Only after the new URL is safely persisted -- see storage.ts.
      await deleteImageByPublicUrl(oldLogoUrl);
    } finally {
      setUploading(false);
    }
  };

  return { editLogo, uploading, canEditLogo, logoUrl: shop?.logoUrl ?? null };
}
