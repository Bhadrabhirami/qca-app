import { Dimensions, StyleSheet } from 'react-native';

const { width } = Dimensions.get('window');

export const COLORS = {
  primary: '#1a472a',    // QCA Green
  secondary: '#d4af37',  // QCA Gold
  background: '#f8f9fa',
  white: '#ffffff',
  textMain: '#333333',
  textLight: '#888888',
  danger: '#ff4444',
  overlay: 'rgba(0,0,0,0.2)',
  modalShadow: 'rgba(0,0,0,0.9)',
};

export const globalStyles = StyleSheet.create({
  container: { 
    flex: 1, 
    backgroundColor: COLORS.background 
  },
  // Header Styles
  header: { 
    padding: 25, 
    backgroundColor: COLORS.primary, 
    borderBottomLeftRadius: 30, 
    borderBottomRightRadius: 30 
  },
  headerRow: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center' 
  },
  title: { 
    color: COLORS.white, 
    fontSize: 24, 
    fontWeight: 'bold' 
  },
  // Card Styles
  card: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    backgroundColor: COLORS.white, 
    padding: 12, 
    borderRadius: 15, 
    marginBottom: 12, 
    elevation: 2 
  },
  cardActive: { 
    backgroundColor: COLORS.primary 
  },
  // Modal Styles
  modalBackground: { 
    flex: 1, 
    backgroundColor: COLORS.modalShadow, 
    justifyContent: 'center', 
    alignItems: 'center' 
  },
  modalContent: { 
    width: width * 0.85, 
    borderRadius: 25, 
    backgroundColor: COLORS.white, 
    overflow: 'hidden', 
    zIndex: 5 
  },
  // Common Text
  textWhite: { 
    color: COLORS.white 
  },
  boldGolden: {
    color: COLORS.secondary,
    fontWeight: '600'
  }
});