import Constants from 'expo-constants';

import { isWhopPreviewEnvironment } from './preview-model';

export const whopPreviewEnabled = isWhopPreviewEnvironment(Constants.expoConfig?.extra?.appEnvironment);
