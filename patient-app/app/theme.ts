"use client";

import { createTheme } from "@mui/material/styles";

// Mirrors the palette that used to live in globals.css custom properties.
const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: "#19764a", dark: "#105c39", contrastText: "#ffffff" },
    secondary: { main: "#1c6f8c", contrastText: "#ffffff" },
    error: { main: "#dd3d42" },
    warning: { main: "#d77a21" },
    background: { default: "#f3f6f2", paper: "#ffffff" },
    text: { primary: "#17332a", secondary: "#65756e" },
    divider: "#dce7e2",
  },
  shape: { borderRadius: 16 },
  typography: {
    fontFamily: "Arial, Helvetica, sans-serif",
    button: { textTransform: "none", fontWeight: 800 },
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { borderRadius: 14, minHeight: 48, fontWeight: 800 },
        sizeLarge: { minHeight: 54, fontSize: 17 },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: { borderRadius: 22, border: "1px solid #dce7e2", boxShadow: "0 14px 36px rgba(23, 51, 42, .055)" },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: "none" },
      },
    },
    MuiBottomNavigation: {
      styleOverrides: {
        root: {
          border: "1px solid #dce7e2",
          boxShadow: "0 14px 40px rgba(15, 42, 32, .16)",
        },
      },
    },
    MuiTextField: {
      defaultProps: { size: "medium" },
    },
  },
});

export default theme;
