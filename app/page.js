"use client"
import React from "react"
import Navbar from "./components/Navbar"
import Box from "@mui/material/Box"; 
import Typography from "@mui/material/Typography";

export default function Home() {
    return (
        <>
        <Navbar page={"Home"}/>
        <Box
            sx={{
                marginTop: '40px', 
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '24px',
                textAlign: 'center',
            }}
            >
            <Typography variant="h4" gutterBottom sx={{ fontSize: '4rem', fontWeight:'bold' }}>
                Welcome to Consumer Compass!
            </Typography>
            <Box
                component="img"
                src="/logo.webp" 
                alt="Consumer Compass Logo"
                sx={{ width: '150px', height: 'auto', marginBottom: '16px' }} 
            />
            <Typography variant="body1" sx={{ maxWidth: '800px', marginTop: '16px', fontSize: '1.5rem' }}>
                This chatbot is designed to help you navigate the complex world of consumer rights in Ontario. 
                Whether you&apos;re dealing with a tricky refund, need guidance on warranties, or want to know your rights when making a purchase, 
                our chatbot is here to provide quick and accurate information tailored to Ontario&apos;s regulations. 
                Get started by signing up (or logging in if you have an existing account) from the menu.
            </Typography>
        </Box>
        </>
    )   
};
