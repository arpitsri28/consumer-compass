"use client"
import React, { useEffect, useState } from "react";
import { Box, Stack, TextField, Button, Typography } from '@mui/material';
import { useAuth } from "../context/authContext";
import { useRouter } from 'next/navigation';
import Navbar from "../components/Navbar";

export default function Chat() {
  const { userLoggedIn, currentUser } = useAuth();
  const router = useRouter();

  
  const [messages, setMessages] = useState([{role: 'assistant', content: 'Welcome! You’ve reached the Ontario Consumer Rights Assistant. Let’s tackle your consumer rights queries together. What can I help you with today?'}]);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!userLoggedIn) {
      router.replace('/auth/login');
      return;
    }
  }, [userLoggedIn, router]);
  const sendMessage = async () => {
    const newMessage = {role: 'user', content: message};
    setMessage('');
    setMessages((prevMessages) => [...prevMessages, newMessage, {role: 'assistant', content: ''}]);
  
    try {
      if (!currentUser) throw new Error('Please sign in before sending a message.');
      const token = await currentUser.getIdToken();
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify([...messages, newMessage]),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message || 'The chat request failed.');
      }
  
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let result = '';
  
      const processText = async ({ done, value }) => {
        if (done) {
          return result;
        }
        const text = decoder.decode(value || new Uint8Array(), { stream: true });
        setMessages((prevMessages) => {
          let lastMessage = prevMessages[prevMessages.length - 1];
          let otherMessages = prevMessages.slice(0, prevMessages.length - 1);
          return [...otherMessages, { ...lastMessage, content: lastMessage.content + text }];
        });
        return reader.read().then(processText);
      };
  
      await reader.read().then(processText);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  return (
    <Box><Navbar page={"Chat"} />
    <Box width="100%" height="93vh" display="flex" flexDirection="column" justifyContent="center" alignItems="center"
         sx={{ background: 'linear-gradient(to right, #3a7bd5, #3a6073)',
              backgroundSize: 'cover', backgroundPosition: 'center' }}>
        
      <Stack direction={'column'} width="100%" height="100%" p={2} spacing={3} sx={{ backgroundColor: 'rgba(255, 255, 255, 0.85)', backdropFilter: 'blur(10px)' }}>
        <Stack direction={'column'} spacing={2} flexGrow={1} overflow="auto" justifyContent={messages.length === 1 ? "center" : "flex-start"}>
          {messages.map((message, index) => (  
            <Box key={index} display="flex" justifyContent={message.role === 'assistant' ? 'flex-start' : 'flex-end'} alignItems="center">
              <Typography variant="body1" color={message.role === 'assistant' ? "text.primary" : "text.secondary"}
                sx={{
                  bgcolor: message.role === 'assistant' ? '#E3F2FD' : '#C8E6C9',
                  p: 2,
                  borderRadius: 2,
                  maxWidth: '70%'
                }}>
                {message.content}
              </Typography>
            </Box>
          ))}
        </Stack>
        <Stack direction={'row'} spacing={2}>
          <TextField label="Message" fullWidth value={message} variant="outlined" onChange={(e) => setMessage(e.target.value)} 
            sx={{ 
              input: { color: '#3E4E50' }, 
              '& .MuiOutlinedInput-root': {
                '& fieldset': { borderColor: '#C8E6C9' }, 
                '&:hover fieldset': { borderColor: '#A5D6A7' }, 
                '&.Mui-focused fieldset': { borderColor: '#A5D6A7' },
              },
              '& .MuiInputLabel-root': { 
                color: '#607D8B', 
                '&.Mui-focused': { 
                  color: '#A5D6A7',
                }
              },
              backgroundColor: '#EEEEEE'
            }} />
          <Button variant="contained" onClick={sendMessage} 
            sx={{ backgroundColor: '#C8E6C9', 
                 '&:hover': { backgroundColor: '#A5D6A7' },
                  color: '#3E4E50'
                 }}>Send</Button>
        </Stack>
      </Stack>
    </Box>
    </Box>
  );
};
